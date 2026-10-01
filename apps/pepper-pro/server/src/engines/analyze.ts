import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import type { Engine } from '@pepper/core/engines/engine.js';
import { errors } from '@pepper/core/errors.js';
import type { JobContext, JobExecutor } from '@pepper/core/jobs/manager.js';
import { safeResolve } from '@pepper/core/paths.js';
import type { TextService } from '@pepper/core/services/text-gen.js';
import { probeMedia, runFfmpeg } from '@pepper/core/util/ffmpeg.js';
import { uniqueOutputName } from '@pepper/core/util/files.js';
import type { ProConfig } from '../config.js';
import type { ProPaths } from '../paths.js';
import { composePrompt } from '../projects/derive.js';
import type { PlanInput, ProjectService, TakeReview } from '../projects/service.js';
import type { RecipeStore } from '../recipes/store.js';

/**
 * `analyze` jobs (docs/PEPPER-PRO.md §8): what the edit and the director need
 * to know about media, as opposed to making it.
 *
 * - `beats`: tempo, beats and downbeats of a track, stored on its asset so a
 *   cut can land on the beat;
 * - `stems`: a song split into vocals and accompaniment, as uploads, so a
 *   performance can be lip-synced to the isolated voice;
 * - `check`: a vision model looks at a take next to its shot and says what is
 *   wrong (a missing subject, the wrong garment colour, garbled text) before
 *   a person has to;
 * - `transcribe`: Whisper's reading of speech, scored against the words it
 *   should say, because a speech model now and then returns noise or the
 *   wrong line for the same seed that worked before;
 * - `plan`: a local model breaks a project's script into cast, scenes and
 *   shots, for "new from script" in the web app (Claude writes plans itself,
 *   through plan_project).
 *
 * Beats and stems run python/analyze.py with ComfyUI's interpreter, on the
 * CPU: they are small next to a video model, and keeping them off the GPU
 * means they never wait for, or evict, the recipe that is rendering.
 */

export interface AnalyzeParams {
  task: 'beats' | 'stems' | 'check' | 'transcribe' | 'plan';
  /** plan: the project whose script becomes scenes and shots. */
  project_id?: string;
  /** An upload name (beats, stems, transcribe). */
  audio?: string;
  /** transcribe: the words the audio should say; the result says how well it does. */
  expected?: string;
  /** transcribe: a kept golden result, by its path under DATA_DIR/golden (set by golden runs). */
  golden_file?: string;
  /** An asset whose audio to analyse; results are stored on it. */
  asset_id?: string;
  /** The take to check or transcribe; the verdict is kept on it. */
  take_id?: string;
  /** Override the configured check model. */
  model?: string;
}

export interface AnalyzeEngineDeps {
  config: ProConfig;
  paths: ProPaths;
  projects: ProjectService;
  recipes: RecipeStore;
  text: TextService;
  /** Where a kept golden result lives (golden/service.ts). */
  goldenPath: (file: string) => string;
  jobs?: { get(id: string): { params: unknown } | null | undefined };
  log: FastifyBaseLogger;
}

const SCRIPT = fileURLToPath(new URL('../../python/analyze.py', import.meta.url));

/** The JSON schema the check model must answer in (llama.cpp constrains decoding to it). */
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    score: { type: 'integer', minimum: 0, maximum: 5 },
    issues: { type: 'array', items: { type: 'string' }, maxItems: 6 },
  },
  required: ['ok', 'score', 'issues'],
};

/** What the plan model must answer: projects.plan()'s input, minus uploads it cannot know. */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    assets: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          kind: { enum: ['character', 'location', 'prop', 'product'] },
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['ref', 'kind', 'name', 'description'],
      },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          shots: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                kind: { enum: ['dialogue', 'action', 'talking', 'broll', 'product', 'establishing'] },
                duration_s: { type: 'number', minimum: 2, maximum: 30 },
                framing: { type: 'string' },
                camera: { type: 'string' },
                prompt: { type: 'string' },
                dialogue: {
                  type: 'array',
                  items: { type: 'object', properties: { speaker: { type: 'string' }, line: { type: 'string' } }, required: ['speaker', 'line'] },
                },
                sound: { type: 'string' },
                assets: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'duration_s', 'prompt'],
            },
          },
        },
        required: ['title', 'shots'],
      },
    },
  },
  required: ['assets', 'scenes'],
};

const PLAN_SYSTEM =
  'You are a director breaking a script into a shot list for an AI video generator. List the recurring ' +
  'characters, locations and products as assets, each with a visual description (age, build, hair, ' +
  'clothes; or materials, light, layout) that stays the same in every shot. Then write scenes of shots, ' +
  '3-15 seconds each. A shot prompt describes what is seen and how it moves, in present tense, without ' +
  "naming the camera; framing and camera go in their own fields. Put spoken lines in dialogue with the " +
  "speaker's asset ref, and ambient sound or music in sound. List the refs of the assets in each shot.";

export class AnalyzeEngine implements Engine {
  readonly id = 'analyze';
  readonly label = 'Analysis (beats, stems, take checks)';

  constructor(private readonly deps: AnalyzeEngineDeps) {}

  executors(): Partial<Record<'analyze', JobExecutor>> {
    return { analyze: (context) => this.run(context) };
  }

  resident(): boolean {
    return false;
  }

  private async run(context: JobContext): Promise<Record<string, unknown>> {
    const params = context.job.params as unknown as AnalyzeParams;
    if (params.task === 'check') return this.check(params, context);
    if (params.task === 'plan') return this.plan(params, context);
    if (params.task === 'transcribe') return this.transcribe(params, context);
    const { path, asset } = this.audioFor(params);
    if (params.task === 'beats') {
      const result = (await this.python(['beats', path], context)) as { bpm: number; beats: number[]; downbeats: number[]; duration: number };
      if (asset) {
        this.deps.projects.updateAsset(asset.id, { meta: { ...(asset.meta as object), beats: result } });
        context.onLog(`${result.beats.length} beats at ${result.bpm} bpm, stored on ${asset.name}`);
      }
      return { task: 'beats', asset_id: asset?.id, ...result };
    }
    if (params.task === 'stems') {
      const work = await mkdtemp(join(this.deps.paths.cacheDir, 'stems-'));
      try {
        const found = (await this.python(['stems', path, work], context)) as { vocals: string; accompaniment: string };
        const names: Record<string, string> = {};
        for (const stem of ['vocals', 'accompaniment'] as const) {
          names[stem] = uniqueOutputName('wav', stem);
          await rename(found[stem], safeResolve(this.deps.paths.uploadsDir, names[stem]));
        }
        const created = asset
          ? (['vocals', 'accompaniment'] as const).map((stem) =>
              this.deps.projects.createAsset(asset.projectId, {
                kind: 'audio',
                name: `${asset.name} (${stem})`,
                audio: names[stem],
                meta: { stem, source_asset_id: asset.id },
              }),
            )
          : [];
        return {
          task: 'stems',
          vocals: names.vocals,
          accompaniment: names.accompaniment,
          audio_url: `/v1/inputs/${encodeURIComponent(names.vocals)}`,
          assets: created.map((a) => ({ id: a.id, name: a.name })),
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    throw errors.validation(`Unknown analyze task "${String(params.task)}"`);
  }

  private async transcribe(params: AnalyzeParams, context: JobContext): Promise<Record<string, unknown>> {
    const { projects, paths } = this.deps;
    let path: string;
    let take: ReturnType<ProjectService['requireTake']> | undefined;
    let expected = params.expected;
    if (params.golden_file) {
      path = this.deps.goldenPath(params.golden_file);
    } else if (params.take_id) {
      take = projects.requireTake(params.take_id);
      if (!take.file) throw errors.validation(`Take ${take.id} has no finished file yet`);
      path = projects.takeFile(take.projectId, take.file);
      // A speech take is judged against what its recipe was asked to say.
      const job = this.deps.jobs?.get(take.jobId);
      expected ??= ((job?.params as { params?: { text?: string } } | undefined)?.params?.text as string | undefined) ?? undefined;
    } else {
      path = this.audioFor(params).path;
    }
    const args = ['transcribe', path, '--cache', join(paths.cacheDir, 'whisper')];
    if (expected) args.push('--expected', expected);
    const result = (await this.python(args, context)) as {
      text: string;
      language: string;
      segments: unknown[];
      match?: { wer: number; ok: boolean };
    };
    if (take && result.match) {
      projects.setTakeReview(take.id, {
        ok: result.match.ok,
        score: Math.max(0, Math.round(5 * (1 - Math.min(1, result.match.wer)))),
        issues: result.match.ok ? [] : [`Heard: "${result.text.slice(0, 160)}"`],
        model: 'whisper-base',
        at: Date.now(),
      });
    }
    return { task: 'transcribe', take_id: take?.id, golden_file: params.golden_file, expected, ...result };
  }

  private audioFor(params: AnalyzeParams) {
    const asset = params.asset_id ? this.deps.projects.requireAsset(params.asset_id) : undefined;
    // A music or audio asset has `audio`; a character's voice clip is the fallback.
    const name = asset ? (asset.audio ?? (asset.voice as { upload?: string } | null)?.upload) : params.audio;
    if (!name) throw errors.validation('Give `audio` (an upload name) or the `asset_id` of an asset with audio');
    return { path: safeResolve(this.deps.paths.uploadsDir, name), asset };
  }

  /** Run analyze.py and return the JSON it prints; its stderr is the job log. */
  private python(args: string[], context: JobContext): Promise<unknown> {
    const { config, paths } = this.deps;
    return new Promise((resolve, reject) => {
      const child = spawn(config.comfyPython, [SCRIPT, ...args], {
        env: { ...process.env, PYTHONUNBUFFERED: '1', TORCH_HOME: join(paths.cacheDir, 'torch'), CUDA_VISIBLE_DEVICES: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let tail = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/[\r\n]+/)) {
          const text = line.trim();
          if (!text) continue;
          tail = text;
          const percent = /(\d+)%\|/.exec(text);
          if (percent) context.onProgress({ step: Number(percent[1]), total: 100, progress: Number(percent[1]) / 100 });
          else context.onLog(text);
        }
      });
      const abort = () => child.kill('SIGTERM');
      context.signal.addEventListener('abort', abort, { once: true });
      child.on('error', (err) => reject(errors.backendUnavailable('analyze', `could not start ${config.comfyPython}: ${err.message}`)));
      child.on('close', (code) => {
        context.signal.removeEventListener('abort', abort);
        // The job manager marks an aborted job cancelled whatever it throws.
        if (context.signal.aborted) return reject(new Error('cancelled'));
        if (code !== 0) return reject(errors.backendUpstreamError('analyze', `analyze.py ${args[0]} failed (${code}): ${tail}`));
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop() ?? ''));
        } catch {
          reject(errors.backendUpstreamError('analyze', `analyze.py printed no result: ${tail}`));
        }
      });
    });
  }

  /**
   * Ask the vision model whether a take shows what its shot asks for. Three
   * frames (or the image) go in with the shot's composed prompt; a verdict in
   * a fixed JSON shape comes out and is kept on the take.
   */
  private async plan(params: AnalyzeParams, context: JobContext): Promise<Record<string, unknown>> {
    const { projects } = this.deps;
    const model = params.model ?? this.deps.config.planModel;
    if (!model) throw errors.validation('No plan model: set PLAN_MODEL (or CHECK_MODEL) to a llama.cpp chat model, or pass `model`');
    if (!params.project_id) throw errors.validation('`project_id` is required to plan a project');
    const project = projects.requireProject(params.project_id);
    if (!project.script.trim()) throw errors.validation('The project has no script to plan from');
    const cast = projects.listAssets(project.id).map((a) => `- ${a.name} (${a.kind}): ${a.description}`);
    context.onLog(`planning ${project.script.length} characters of script with ${model}`);
    const result = await this.deps.text.generate({
      signal: context.signal,
      onLog: context.onLog,
      params: {
        model,
        temperature: 0.3,
        max_tokens: 8000,
        response_format: { type: 'json_schema', json_schema: { name: 'plan', schema: PLAN_SCHEMA } },
        messages: [
          { role: 'system', content: PLAN_SYSTEM },
          {
            role: 'user',
            content:
              `Aspect ${project.aspect}. Style: ${project.style || 'not set'}.\n` +
              (cast.length ? `Cast and assets already in the project (use these names):\n${cast.join('\n')}\n` : '') +
              `\nThe script:\n${project.script}`,
          },
        ],
      },
    });
    let plan: PlanInput;
    try {
      plan = JSON.parse(result.text) as PlanInput;
    } catch {
      throw errors.backendUpstreamError('llamacpp', `the plan model answered without JSON: ${result.text.slice(0, 200)}`);
    }
    if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
      throw errors.backendUpstreamError('llamacpp', 'the plan model returned no scenes');
    }
    const applied = projects.plan(project.id, { assets: plan.assets ?? [], scenes: plan.scenes });
    return { task: 'plan', project_id: project.id, assets: applied.assets.length, scenes: applied.scenes.length, shots: applied.shots.length };
  }

  private async check(params: AnalyzeParams, context: JobContext): Promise<Record<string, unknown>> {
    const { projects, paths } = this.deps;
    const model = params.model ?? this.deps.config.checkModel;
    if (!model) {
      throw errors.validation('No check model: set CHECK_MODEL to a llama.cpp vision model (GGUF plus its mmproj, as GET /v1/llm/models lists it), or pass `model`');
    }
    if (!params.take_id) throw errors.validation('`take_id` is required to check a take');
    const take = projects.requireTake(params.take_id);
    if (!take.file) throw errors.validation(`Take ${take.id} has no finished file yet`);
    const shot = projects.requireShot(take.shotId);
    const project = projects.requireProject(take.projectId);
    const assets = projects.listAssets(project.id);
    const request = await projects.requestFor(shot.id, take.mode).catch(() => null);
    const recipe = request ? this.deps.recipes.get(request.recipe) : undefined;
    const intent = recipe ? composePrompt({ project, shot, assets, recipe }) : shot.prompt;

    const path = projects.takeFile(project.id, take.file);
    const images = await this.frames(path, context);
    context.onLog(`checking ${images.length} frame(s) with ${model}`);
    const result = await this.deps.text.generate({
      signal: context.signal,
      onLog: context.onLog,
      params: {
        model,
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_schema', json_schema: { name: 'review', schema: REVIEW_SCHEMA } },
        messages: [
          {
            role: 'system',
            content:
              'You review frames from a generated video shot against its brief. Report only concrete, visible ' +
              'problems: a subject that is missing or duplicated, wrong clothing or colours, a wrong setting, ' +
              'deformed hands or faces, garbled text or logos. Score 5 when it matches the brief.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: `The brief:\n${intent}\n\nThe frames, in order:` },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      },
    });
    let parsed: { ok?: boolean; score?: number; issues?: string[] };
    try {
      parsed = JSON.parse(result.text) as typeof parsed;
    } catch {
      throw errors.backendUpstreamError('llamacpp', `the check model answered without JSON: ${result.text.slice(0, 200)}`);
    }
    const review: TakeReview = {
      ok: Boolean(parsed.ok),
      score: Math.max(0, Math.min(5, Math.round(Number(parsed.score) || 0))),
      issues: (parsed.issues ?? []).map(String).slice(0, 6),
      model,
      at: Date.now(),
    };
    projects.setTakeReview(take.id, review);
    return { task: 'check', take_id: take.id, review };
  }

  /** Three frames of a video (at 15, 50 and 85 %), or the image itself, as data URLs. */
  private async frames(path: string, context: JobContext): Promise<string[]> {
    const info = await probeMedia(path);
    const dir = await mkdtemp(join(this.deps.paths.cacheDir, 'frames-'));
    try {
      await mkdir(dir, { recursive: true });
      const times = info.still || !info.hasVideo ? [0] : [0.15, 0.5, 0.85].map((f) => f * info.duration);
      const urls: string[] = [];
      for (const [index, at] of times.entries()) {
        const out = join(dir, `${index}.jpg`);
        await runFfmpeg(['-y', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', path, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', out]);
        urls.push(`data:image/jpeg;base64,${(await readFile(out)).toString('base64')}`);
      }
      context.onProgress({ step: 1, total: 2, progress: 0.3 });
      return urls;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
