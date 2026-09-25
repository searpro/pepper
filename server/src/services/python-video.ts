import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { AppError, errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { StepProgress } from '../logs/parse.js';
import type { BackendManager } from '../backends/manager.js';
import { runnerSourceDir, type PythonRuntime } from '../backends/python.js';
import {
  resolveS2vConfig,
  slotDirName,
  type BundleInfo,
  type ComponentSlot,
  type ResolvedImageBundle,
} from '../models/bundle.js';
import { bundleDir, safeResolve, type Paths } from '../paths.js';
import type { GenerateParams } from '../schemas/generate.js';
import { uniqueOutputName } from '../util/files.js';
import { generateSpeechVideo } from './s2v.js';

/**
 * Video generation through Pepper's Python runners (`server/python/pepper_runner`).
 *
 * The shape deliberately mirrors sd-cli rather than the managed-server
 * backends: one process per job that loads the model, writes one file and
 * exits. Video models on a unified-memory machine cannot stay resident next
 * to an LLM, a crashed job cannot poison the next one, and cancellation is a
 * kill — no in-process state to unwind.
 *
 * The runner talks back over stdout with `@@pepper {json}` lines (progress,
 * stages, the result or the error); everything else is log output.
 */

const MARKER = '@@pepper ';
/** Backends that hold model memory while idle, stopped before a job when configured. */
const RESIDENT_BACKENDS = ['llamacpp', 'audiocpp', 'vllm'] as const;

export interface PythonVideoResult {
  outputPath: string;
  outputName: string;
  kind: 'video';
  durationMs: number;
  params: GenerateParams;
  /** What the runner reports: final size, frames, fps, seed, mode. */
  runner: Record<string, unknown>;
}

/** One runner invocation: what `python -m pepper_runner` reads from its spec file. */
interface RunnerSpec {
  runner: string;
  output: string;
  components: Record<string, string>;
  package_dir: string | null;
  params: Record<string, unknown>;
  inputs: { image: string | null; audio: string | null };
}

interface RunnerMessage {
  type: 'stage' | 'progress' | 'result' | 'error';
  stage?: string;
  step?: number;
  total?: number;
  message?: string;
  [key: string]: unknown;
}

export class PythonVideoService {
  private readonly children = new Set<ChildProcess>();
  /** One environment install at a time, shared by jobs that arrive during it. */
  private preparing: Promise<PythonRuntime> | null = null;

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly backends: BackendManager,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {}

  get stats(): { running: number } {
    return { running: this.children.size };
  }

  killAll(): void {
    for (const child of this.children) child.kill('SIGKILL');
  }

  /**
   * The interpreter to run jobs with, installing the managed runtime and the
   * runner's requirements on first use. First use takes minutes (torch alone
   * is hundreds of megabytes); every later job costs a receipt check.
   */
  async prepare(onLog?: (line: string) => void, signal?: AbortSignal): Promise<PythonRuntime> {
    if (this.config.pythonExecutable) {
      return {
        pythonPath: this.config.pythonExecutable,
        runtimeDir: '',
        venvDir: '',
        version: 'external',
        installedAt: '',
      };
    }
    this.preparing ??= (async () => {
      const installer = this.backends.python;
      let runtime = await installer.installed();
      if (!runtime) {
        onLog?.('Installing the Python runtime (first Python job only)…');
        runtime = await installer.installRuntime(signal);
      }
      onLog?.('Checking the Python runner environment…');
      await installer.ensureRunnerEnvironment(runtime, signal);
      return runtime;
    })().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  async generate(options: {
    bundle: BundleInfo;
    params: GenerateParams;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<PythonVideoResult> {
    const { bundle, params, signal } = options;
    const manifest = bundle.manifest;
    const runnerName = manifest?.python_runner;
    if (!runnerName) {
      throw errors.invalidModel(
        `Model "${bundle.id}" has no python_runner — it cannot generate through the Python backend`,
      );
    }
    if (!bundle.ready)
      throw errors.invalidModel(`Model "${bundle.id}" is not ready: ${bundle.readyReason}`);

    const log = (line: string) => {
      options.onLog?.(line);
      this.logs.push({ level: 'info', source: 'python', msg: line });
    };

    const runtime = await this.prepare(log, signal);

    // Upstream model code the runner imports (EchoMimicV3's src/), cloned at
    // its pinned commit without upstream's own requirements.
    let packageDir: string | undefined;
    if (manifest?.python_package) {
      if (this.config.pythonExecutable) {
        packageDir = this.backends.python.packageDir(manifest.python_package);
      } else {
        packageDir = await this.backends.python.installPackage(
          runtime,
          { source: manifest.python_package },
          signal,
          { requirements: false },
        );
      }
      await access(packageDir, constants.R_OK).catch(() => {
        throw errors.invalidModel(
          `Package ${manifest.python_package} is not installed at ${packageDir}`,
        );
      });
    }

    if (this.config.pythonExclusiveMemory) await this.freeResidentBackends(log);

    await mkdir(this.paths.outputDir, { recursive: true });
    // Speech-driven output is stitched by the S2V orchestrator, which encodes
    // VP9/Opus — a .webm, like sd-cli's video output. Everything else is the
    // runner's own H.264 MP4.
    const speechDriven = Boolean(params.audio) && bundle.capabilities.includes('s2v');
    const outputName = uniqueOutputName(speechDriven ? 'webm' : 'mp4');
    const outputPath = safeResolve(this.paths.outputDir, outputName);
    const started = Date.now();

    const dir = bundleDir(this.paths, bundle.kind, bundle.id);
    const components: Record<string, string> = {};
    for (const slot of new Set(bundle.components.map((c) => c.slot))) {
      components[slot] = join(dir, slotDirName(slot as ComponentSlot));
    }

    const baseParams = {
      ...(manifest?.defaults ?? {}),
      ...definedOnly({
        prompt: params.prompt,
        negative_prompt: params.negative_prompt,
        steps: params.steps,
        cfg_scale: params.cfg_scale,
        width: params.width,
        height: params.height,
        seed: params.seed,
        video_frames: params.video_frames,
        fps: params.fps,
        strength: params.strength,
      }),
    };
    const image = params.init_image ? await this.resolveUpload(params.init_image) : null;
    const audio = params.audio ? await this.resolveUpload(params.audio) : null;
    const spec = (overrides: Partial<RunnerSpec>): RunnerSpec => ({
      runner: runnerName,
      output: outputPath,
      components,
      package_dir: packageDir ?? null,
      params: baseParams,
      inputs: { image, audio },
      ...overrides,
    });
    this.log.info(
      { model: bundle.id, runner: runnerName, output: outputName },
      'running Python video job',
    );

    // A speech-driven model conditions on a few seconds at a time, so a
    // recording goes through the same orchestrator as sd-cli's S2V models:
    // overlapping chunks, each seeded with the previous chunk's last frame,
    // stitched and re-muxed with the whole recording. One chunk is just the
    // short case of that.
    if (audio && speechDriven) {
      // The model's native frame rate is not a preference: EchoMimicV3's audio
      // features are aligned to 25 fps, and the orchestrator sizes each chunk
      // from this number.
      const fps = manifest?.defaults?.fps ?? params.fps;
      let last: RunnerMessage = { type: 'result' };
      const summary = await generateSpeechVideo({
        // The chunk window is the model's (its manifest `s2v` block): a
        // request asking for longer chunks would get audio the runner does not
        // render frames for, and the stitch would drift.
        params: { ...params, fps, audio_chunk_seconds: undefined, audio_overlap_seconds: undefined },
        bundle: {
          id: bundle.id,
          s2v: resolveS2vConfig(manifest),
          defaults: manifest?.defaults ?? {},
        } as unknown as ResolvedImageBundle,
        audioPath: audio,
        outputPath,
        initImagePath: image ?? undefined,
        timeoutMs: this.config.sdcppVideoTimeoutMs,
        log: this.log,
        onProgress: options.onProgress,
        signal,
        runChunk: async (chunk) => {
          // The stitcher reads segments by content; the runner's MP4 muxer is
          // chosen by extension, so it writes .mp4 and is renamed into place.
          const segment = `${chunk.outputPath}.mp4`;
          last = await this.runSpec(
            runtime.pythonPath,
            spec({
              output: segment,
              params: {
                ...baseParams,
                video_frames: chunk.params.video_frames,
                fps: chunk.params.fps,
                exact_frames: true,
                mux_audio: false,
              },
              inputs: { image: chunk.initImagePath ?? null, audio: chunk.audioPath },
            }),
            { onProgress: chunk.onProgress, onLog: log, signal },
          );
          await rename(segment, chunk.outputPath);
        },
      });
      const {
        type: _type,
        duration_ms: _ms,
        frames: _frames,
        audio_seconds: _a,
        ...metadata
      } = last;
      return {
        outputPath,
        outputName,
        kind: 'video',
        durationMs: Date.now() - started,
        params: { ...params, seed: (metadata.seed as number | undefined) ?? params.seed },
        runner: {
          ...metadata,
          fps: summary.fps,
          mode: 's2v',
          audio_duration_s: Number(summary.audioDurationSeconds.toFixed(2)),
          audio_chunks: summary.chunks,
        },
      };
    }

    const runner = await this.runSpec(runtime.pythonPath, spec({}), {
      onProgress: options.onProgress,
      onLog: log,
      signal,
    });
    const { type: _type, duration_ms, ...metadata } = runner;
    return {
      outputPath,
      outputName,
      kind: 'video',
      durationMs: Number(duration_ms) || Date.now() - started,
      params: { ...params, seed: (metadata.seed as number | undefined) ?? params.seed },
      runner: metadata,
    };
  }

  /**
   * Run a non-video runner (the upscaler) once: same runtime, protocol and
   * cancellation as a video job, without the model-bundle plumbing.
   */
  async runTask(options: {
    runner: string;
    output: string;
    params: Record<string, unknown>;
    inputs: { image?: string | null; audio?: string | null };
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const log = (line: string) => {
      options.onLog?.(line);
      this.logs.push({ level: 'info', source: 'python', msg: line });
    };
    const runtime = await this.prepare(log, options.signal);
    const { type: _type, ...result } = await this.runSpec(
      runtime.pythonPath,
      {
        runner: options.runner,
        output: options.output,
        components: {},
        package_dir: null,
        params: options.params,
        inputs: { image: options.inputs.image ?? null, audio: options.inputs.audio ?? null },
      },
      { onProgress: options.onProgress, onLog: log, signal: options.signal },
    );
    return result;
  }

  /** Whether a Python job can start without first installing the runtime. */
  async runtimeInstalled(): Promise<boolean> {
    if (this.config.pythonExecutable) return true;
    return (await this.backends.python.installed()) !== null;
  }

  /** Write a spec file, run the runner on it, and clean up. */
  private async runSpec(
    python: string,
    job: RunnerSpec,
    hooks: {
      onProgress?: (p: StepProgress) => void;
      onLog: (line: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<RunnerMessage> {
    const specPath = join(this.paths.cacheDir, `python-job-${uniqueOutputName('json')}`);
    await writeFile(specPath, JSON.stringify(job, null, 2));
    try {
      return await this.run(python, specPath, job.output, hooks);
    } finally {
      await rm(specPath, { force: true });
    }
  }

  private async resolveUpload(name: string): Promise<string> {
    const path = safeResolve(this.paths.uploadsDir, name);
    try {
      await access(path, constants.R_OK);
    } catch {
      throw errors.inputNotFound(name);
    }
    return path;
  }

  /**
   * Stop the backends that keep a model resident. They are started lazily by
   * the next request that needs them, so this costs a reload later rather than
   * risking the machine now: on the 24 GB Mac this was built on, a video
   * decode alongside a resident LLM once exhausted memory and swap and took
   * the whole machine down.
   */
  private async freeResidentBackends(log: (line: string) => void): Promise<void> {
    for (const backend of RESIDENT_BACKENDS) {
      const proc = this.backends.get(backend);
      if (!proc || proc.status === 'stopped' || proc.status === 'failed') continue;
      log(
        `Stopping ${backend} to free memory for the video model (it restarts on its next request)`,
      );
      await proc.stop().catch((err) => this.log.warn({ backend, err }, 'could not stop backend'));
    }
  }

  private run(
    python: string,
    specPath: string,
    outputPath: string,
    hooks: {
      onProgress?: (p: StepProgress) => void;
      onLog: (line: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<RunnerMessage> {
    const timeoutMs = this.config.sdcppVideoTimeoutMs;
    const cwd = runnerSourceDir();

    return new Promise<RunnerMessage>((resolvePromise, reject) => {
      const child = spawn(python, ['-m', 'pepper_runner', specPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONPATH: cwd,
          PYTHONUNBUFFERED: '1',
          PYTORCH_ENABLE_MPS_FALLBACK: '1',
          HF_HUB_OFFLINE: '1',
        },
      });
      this.children.add(child);

      let settled = false;
      let result: RunnerMessage | null = null;
      let failure: string | null = null;
      const tail: string[] = [];

      const finish = (err: Error | null, value?: RunnerMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        hooks.signal?.removeEventListener('abort', onAbort);
        this.children.delete(child);
        if (err) reject(err);
        else resolvePromise(value!);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(errors.processTimeout(timeoutMs));
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(new AppError('GENERATION_FAILED', 'Generation cancelled', 499));
      };
      hooks.signal?.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string) => {
        if (!line) return;
        if (!line.startsWith(MARKER)) {
          tail.push(line);
          if (tail.length > 40) tail.shift();
          hooks.onLog(line);
          return;
        }
        let message: RunnerMessage;
        try {
          message = JSON.parse(line.slice(MARKER.length)) as RunnerMessage;
        } catch {
          return;
        }
        if (message.type === 'progress' && message.total) {
          const step = Math.min(message.step ?? 0, message.total);
          hooks.onProgress?.({ step, total: message.total, progress: step / message.total });
        } else if (message.type === 'stage' && message.stage) {
          hooks.onLog(
            `[stage] ${message.stage}${message.memory ? ` (${String(message.memory)})` : ''}`,
          );
        } else if (message.type === 'result') {
          result = message;
        } else if (message.type === 'error') {
          failure = message.message ?? 'Python runner failed';
        }
      };

      if (child.stdout) createInterface({ input: child.stdout }).on('line', handleLine);
      if (child.stderr) createInterface({ input: child.stderr }).on('line', handleLine);

      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        finish(
          e.code === 'ENOENT'
            ? errors.backendBinaryNotFound('python', python)
            : errors.generationFailed(`Failed to start the Python runner: ${e.message}`),
        );
      });

      child.on('close', async (code, signalName) => {
        if (settled) return;
        if (code !== 0 || !result) {
          return finish(
            errors.generationFailed(
              failure ??
                `Python runner exited with code ${code ?? 'null'}${signalName ? ` (signal ${signalName})` : ''}`,
              { exitCode: code, signal: signalName, output: tail.slice(-15) },
            ),
          );
        }
        try {
          const s = await stat(outputPath);
          if (!s.isFile() || s.size === 0) throw new Error('empty');
        } catch {
          return finish(
            errors.generationFailed('Python runner reported success but wrote no output'),
          );
        }
        finish(null, result);
      });
    });
  }
}

function definedOnly(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined && v !== null),
  );
}
