import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { AppError, errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import { parseBackendLine, parseProgress, type StepProgress } from '../logs/parse.js';
import { safeResolve, type Paths } from '../paths.js';
import { uniqueOutputName } from '../util/files.js';
import type { ModelManager } from '../models/manager.js';
import type { BackendManager } from '../backends/manager.js';
import { loaderEnv } from '../backends/process.js';
import { buildImageArgs } from './image-args.js';
import { generateSpeechVideo } from './s2v.js';
import type { GenerateParams } from '../schemas/generate.js';

/**
 * Image and video generation via stable-diffusion.cpp (requirement 1).
 *
 * sd-cli is a one-shot CLI, not a server: it is spawned per generation, loads
 * the model, writes a file and exits. That is why it sits outside the process
 * manager's supervision table — there is no long-running process to keep
 * single, monitor for swap, or restart. What it does share with the supervised
 * backends is everything downstream of the spawn: the same line parser gives
 * its output real severities, the same log buffer receives it, and the same
 * `JobManager` owns queueing and cancellation.
 */

export interface GenerateResult {
  outputPath: string;
  outputName: string;
  kind: 'image' | 'video';
  durationMs: number;
  /** Request values merged with the bundle's manifest defaults. */
  params: GenerateParams;
  /** Speech-to-video only: how the run was split. */
  s2v?: { audioDurationSeconds: number; chunks: number; fps: number };
}

export interface GenerateOptions {
  params: GenerateParams;
  onProgress?: (progress: StepProgress) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export class ImageService {
  /**
   * Every live sd-cli process. Nothing else tracks them — the job manager
   * tracks *jobs* — so without this a process orphaned by a server restart
   * keeps running and holding a model in memory while the new server spawns
   * its own. `killAll()` on shutdown is what stops that.
   */
  private readonly children = new Set<ChildProcess>();

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly models: ModelManager,
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

  /** Resolve an uploaded input name to a readable absolute path. */
  private async resolveUpload(name: string): Promise<string> {
    const path = safeResolve(this.paths.uploadsDir, name);
    try {
      await access(path, constants.R_OK);
    } catch {
      throw errors.inputNotFound(name);
    }
    return path;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const { params, onProgress, onLog, signal } = options;

    const binaryPath = await this.resolveBinary(signal);
    await mkdir(this.paths.outputDir, { recursive: true });

    const bundle = await this.models.resolveImage(params.model);

    // Manifest defaults sit *under* the request: an explicit value always
    // wins, and a model that ships sensible defaults means a caller can send
    // nothing but a prompt.
    const effective: GenerateParams = {
      ...params,
      negative_prompt: params.negative_prompt ?? bundle.defaults.negative_prompt,
      steps: params.steps ?? bundle.defaults.steps,
      cfg_scale: params.cfg_scale ?? bundle.defaults.cfg_scale,
      width: params.width ?? bundle.defaults.width,
      height: params.height ?? bundle.defaults.height,
      sampler: params.sampler ?? (bundle.defaults.sampler as GenerateParams['sampler']),
      video_frames: params.video_frames ?? bundle.defaults.video_frames,
      flow_shift: params.flow_shift ?? bundle.defaults.flow_shift,
      fps: params.fps ?? bundle.defaults.fps,
      // sd-cli falls back to a fixed seed (42) when none is passed, so an
      // omitted or -1 seed is resolved here instead: every run differs, and the
      // seed that produced an image is recorded so it can be reproduced.
      seed: params.seed !== undefined && params.seed >= 0 ? params.seed : randomInt(0, 2 ** 31 - 1),
    };

    const images = {
      init: params.init_image ? await this.resolveUpload(params.init_image) : undefined,
      mask: params.mask ? await this.resolveUpload(params.mask) : undefined,
      refs: params.ref_images
        ? await Promise.all(params.ref_images.map((name) => this.resolveUpload(name)))
        : undefined,
    };

    // sd-cli's video output only supports .avi, .webm or animated .webp — not
    // .mp4, which it silently writes as "<path>.avi" rather than rejecting, so
    // the file check would fail with nothing at the expected path. .webm is
    // the one a browser <video> tag actually plays.
    const outputName = uniqueOutputName(bundle.mode === 'video' ? 'webm' : 'png');
    const outputPath = safeResolve(this.paths.outputDir, outputName);

    const timeoutMs =
      bundle.mode === 'video' ? this.config.sdcppVideoTimeoutMs : this.config.sdcppTimeoutMs;

    // Speech conditioning takes a different path entirely: one spawn per audio
    // chunk, stitched afterwards. Everything above it — bundle resolution,
    // defaults, upload resolution — is shared, which is why the fork is here
    // and not at the route.
    if (params.audio) {
      return this.generateFromSpeech({
        params: effective,
        bundle,
        binaryPath,
        audioPath: await this.resolveUpload(params.audio),
        initImagePath: images.init,
        outputPath,
        outputName,
        timeoutMs,
        onProgress,
        onLog,
        signal,
      });
    }

    const args = buildImageArgs({
      params: effective,
      bundle,
      outputPath,
      images,
      backendArgs: this.backends.argv('sdcpp'),
    });

    this.log.info(
      {
        model: bundle.id,
        loadMode: bundle.loadMode,
        mode: bundle.mode,
        weights: Object.keys(bundle.weights),
        refs: images.refs?.length ?? 0,
      },
      'resolved model bundle',
    );

    const { durationMs } = await this.run({
      binaryPath,
      args,
      outputPath,
      kind: bundle.mode,
      timeoutMs,
      onProgress,
      onLog,
      signal,
    });
    return { outputPath, outputName, kind: bundle.mode, durationMs, params: effective };
  }

  /**
   * Speech-to-video: slice, render each chunk, stitch.
   *
   * The chunk runner handed to the orchestrator is `run()` with the model
   * flags already bound, so every chunk spawns through exactly the same code
   * path — and the same cancellation, timeout and log plumbing — as an
   * ordinary single generation.
   */
  private async generateFromSpeech(input: {
    params: GenerateParams;
    bundle: Awaited<ReturnType<ModelManager['resolveImage']>>;
    binaryPath: string;
    audioPath: string;
    initImagePath?: string;
    outputPath: string;
    outputName: string;
    timeoutMs: number;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<GenerateResult> {
    const { bundle, params, outputPath, outputName, timeoutMs, binaryPath } = input;
    const started = Date.now();

    if (bundle.mode !== 'video') {
      throw errors.validation(
        `Model "${bundle.id}" is an image model; audio input requires a video model.`,
      );
    }

    const audioFlag = bundle.s2v?.audioFlag;

    const summary = await generateSpeechVideo({
      params,
      bundle,
      audioPath: input.audioPath,
      initImagePath: input.initImagePath,
      outputPath,
      timeoutMs,
      log: this.log,
      onProgress: input.onProgress,
      signal: input.signal,
      runChunk: async (chunk) => {
        const args = buildImageArgs({
          params: chunk.params,
          bundle,
          outputPath: chunk.outputPath,
          images: { init: chunk.initImagePath, initFlag: chunk.initImageFlag },
          audio: { path: chunk.audioPath, flag: audioFlag! },
          backendArgs: this.backends.argv('sdcpp'),
        });

        await this.run({
          binaryPath,
          args,
          outputPath: chunk.outputPath,
          kind: 'video',
          // Each chunk gets the full video budget: the ceiling is meant to
          // catch a wedged process, and a forty-chunk run legitimately takes
          // forty times as long as a one-chunk one.
          timeoutMs,
          onProgress: chunk.onProgress,
          onLog: input.onLog,
          signal: input.signal,
        });
      },
    });

    return {
      outputPath,
      outputName,
      kind: 'video',
      durationMs: Date.now() - started,
      params,
      s2v: {
        audioDurationSeconds: summary.audioDurationSeconds,
        chunks: summary.chunks,
        fps: summary.fps,
      },
    };
  }

  /**
   * One ESRGAN pass through sd-cli's `upscale` mode.
   *
   * sd-cli exits 0 and writes the *unscaled* input when it cannot load the
   * upscaler (RealESRGAN_x2plus's pixel-unshuffle input layer, for one), so
   * success is judged by the "upscaling from … to …" line it logs only once
   * the model is actually running — not by the exit code or the file.
   */
  async runUpscaler(input: {
    modelPath: string;
    inputPath: string;
    outputPath: string;
    tileSize?: number;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<{ durationMs: number; from?: [number, number]; to?: [number, number] }> {
    const binaryPath = await this.resolveBinary(input.signal);
    await mkdir(this.paths.outputDir, { recursive: true });

    let from: [number, number] | undefined;
    let to: [number, number] | undefined;
    const args = [
      '-M',
      'upscale',
      '--upscale-model',
      input.modelPath,
      '-i',
      input.inputPath,
      '-o',
      input.outputPath,
      // sd-cli's default tile (128) measured fastest on Metal: 256 was ~15%
      // slower on a 640×480 → 4× run.
      ...(input.tileSize ? ['--upscale-tile-size', String(input.tileSize)] : []),
    ];

    const { durationMs } = await this.run({
      binaryPath,
      args,
      outputPath: input.outputPath,
      kind: 'image',
      timeoutMs: this.config.sdcppTimeoutMs,
      onProgress: input.onProgress,
      signal: input.signal,
      onLog: (line) => {
        const m = /upscaling from \((\d+) x (\d+)\) to \((\d+) x (\d+)\)/.exec(line);
        if (m) {
          from = [Number(m[1]), Number(m[2])];
          to = [Number(m[3]), Number(m[4])];
        }
        input.onLog?.(line);
      },
    });
    return { durationMs, from, to };
  }

  private async resolveBinary(signal?: AbortSignal): Promise<string> {
    const installed = await this.backends.ensureInstalled('sdcpp', signal);
    if (!installed) throw errors.backendBinaryNotFound('sdcpp', 'sd-cli');
    return installed.binaryPath;
  }

  /** Spawn sd-cli once and resolve when it has written a non-empty output. */
  private run(input: {
    binaryPath: string;
    args: string[];
    outputPath: string;
    kind: 'image' | 'video';
    timeoutMs: number;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<{ durationMs: number }> {
    const { binaryPath, args, outputPath, kind, timeoutMs } = input;
    const started = Date.now();
    this.log.info({ bin: binaryPath, args }, 'spawning sd-cli');

    return new Promise<{ durationMs: number }>((resolvePromise, reject) => {
      const child = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: loaderEnv(binaryPath),
      });
      this.children.add(child);

      let settled = false;
      const errorTail: string[] = [];

      const finish = (err: Error | null, result?: { durationMs: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        this.children.delete(child);
        if (err) reject(err);
        else resolvePromise(result!);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        this.log.warn({ timeoutMs }, 'generation timed out, killing sd-cli');
        child.kill('SIGKILL');
        finish(errors.processTimeout(timeoutMs));
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        child.kill('SIGKILL');
        finish(new AppError('GENERATION_FAILED', 'Generation cancelled', 499));
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string, stream: 'stdout' | 'stderr') => {
        if (!line) return;
        input.onLog?.(line);

        const { level, message, origin } = parseBackendLine(line, stream);
        this.logs.push({
          level,
          source: 'sdcpp',
          msg: message,
          fields: origin ? { origin } : undefined,
        });

        if (stream === 'stderr') {
          errorTail.push(line);
          if (errorTail.length > 50) errorTail.shift();
        }

        const progress = parseProgress(line);
        if (progress) input.onProgress?.(progress);
      };

      if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', (line) => handleLine(line, 'stdout'));
      }
      if (child.stderr) {
        createInterface({ input: child.stderr }).on('line', (line) => handleLine(line, 'stderr'));
      }

      child.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        finish(
          e.code === 'ENOENT'
            ? errors.backendBinaryNotFound('sdcpp', binaryPath)
            : errors.generationFailed(`Failed to start sd-cli: ${e.message}`),
        );
      });

      child.on('close', async (code, signalName) => {
        if (settled) return;

        if (code !== 0) {
          const reason = extractFailureReason(errorTail);
          return finish(
            errors.generationFailed(
              `stable-diffusion.cpp exited with code ${code ?? 'null'}${
                signalName ? ` (signal ${signalName})` : ''
              }${reason ? `: ${reason}` : ''}`,
              { exitCode: code, signal: signalName, stderr: errorTail.slice(-15) },
            ),
          );
        }

        // Exit 0 is not proof of output: sd-cli writes nothing when it cannot
        // encode to the requested container, and reports success anyway.
        try {
          const s = await stat(outputPath);
          if (!s.isFile() || s.size === 0) {
            return finish(
              errors.generationFailed(`sd-cli exited 0 but produced no ${kind}`, {
                stderr: errorTail.slice(-10),
              }),
            );
          }
        } catch {
          return finish(
            errors.generationFailed(`sd-cli exited 0 but the output ${kind} is missing`, {
              stderr: errorTail.slice(-10),
            }),
          );
        }

        finish(null, { durationMs: Date.now() - started });
      });
    });
  }
}

/** Pull the most informative lines out of a failed run's stderr. */
function extractFailureReason(stderr: string[]): string | null {
  const meaningful = stderr.filter((line) =>
    /error|fail|fatal|cannot|unable|missing|not found|unsupported|assert/i.test(line),
  );
  const picked = (meaningful.length > 0 ? meaningful : stderr).slice(-3);
  const joined = picked.join(' | ').trim();
  return joined.length > 0 ? joined.slice(0, 500) : null;
}
