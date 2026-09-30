import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Engine, MemoryArbiter, ReleaseReason } from '@pepper/core/engines/engine.js';
import { AppError, errors } from '@pepper/core/errors.js';
import type { JobContext, JobExecutor } from '@pepper/core/jobs/manager.js';
import { safeResolve } from '@pepper/core/paths.js';
import { Semaphore } from '@pepper/core/util/semaphore.js';
import { uniqueOutputName } from '@pepper/core/util/files.js';
import type { BackendManager } from '@pepper/core/backends/manager.js';
import { ComfyClient, PromptRejected, type ExecutionEvent, type ObjectInfo, type OutputFile, type Prompt } from '../comfy/client.js';
import type { ProConfig } from '../config.js';
import { proErrors } from '../errors.js';
import type { ProPaths } from '../paths.js';
import type { Recipe, WorkflowSpec } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import { licenceBlock } from '../recipes/store.js';
import { buildPrompt } from './build.js';
import { checkUploads, resolveParams, type ParamValues } from './params.js';

/**
 * Every image, video and audio job in Pepper Pro, run through ComfyUI
 * (docs/PEPPER-PRO.md §5).
 *
 * A job names a recipe, a mode and parameters. The engine resolves the
 * parameters, builds the prompt from the recipe's workflow, makes room in
 * memory, queues it, turns ComfyUI's per-node events into one progress bar,
 * and moves the files it wrote into Pepper's outputs.
 *
 * One prompt at a time: ComfyUI's interrupt is global, so with two prompts
 * in flight a cancel could stop the wrong one. On one GPU nothing is lost —
 * two video jobs would not fit side by side anyway.
 */

export interface RecipeJobParams {
  recipe: string;
  mode?: string;
  params?: ParamValues;
  /** Set by the project service when the job is a take. */
  shot_id?: string;
  take_id?: string;
}

export interface ComfyEngineDeps {
  config: ProConfig;
  paths: ProPaths;
  backends: BackendManager;
  recipes: RecipeStore;
  memory: MemoryArbiter;
  log: FastifyBaseLogger;
}

const OUT_OF_MEMORY = /out of memory|OutOfMemoryError|Allocation on device|CUDA error: out of memory|MPS backend out of memory/i;

export class ComfyEngine implements Engine {
  readonly id = 'comfy';
  readonly label = 'ComfyUI';
  private readonly slot = new Semaphore(1);
  private objectInfo: ObjectInfo | null = null;
  /** The recipe family whose models ComfyUI last loaded. */
  private family: string | null = null;
  private jobsSinceStart = 0;
  private client: ComfyClient;

  constructor(private readonly deps: ComfyEngineDeps) {
    this.client = new ComfyClient(deps.backends.baseUrl('comfy'));
  }

  executors(): Partial<Record<'image' | 'video' | 'audio', JobExecutor>> {
    const run: JobExecutor = (context) => this.run(context);
    return { image: run, video: run, audio: run };
  }

  resident(): boolean {
    const proc = this.deps.backends.get('comfy');
    return Boolean(proc && proc.status !== 'stopped' && proc.status !== 'failed');
  }

  async release(reason: ReleaseReason): Promise<void> {
    if (!this.resident()) return;
    if (reason === 'shutdown') {
      await this.deps.backends.get('comfy')?.stop();
      return;
    }
    // Freeing is enough to hand the GPU over; stopping would cost a two-minute
    // boot on the next job for the same effect.
    await this.client.free({ unloadModels: true, freeMemory: true }).catch(() => {});
    this.family = null;
  }

  async shutdown(): Promise<void> {
    await this.release('shutdown');
  }

  /** The node types this ComfyUI knows, fetched once per ComfyUI process. */
  async nodeTypes(): Promise<ObjectInfo> {
    if (!this.objectInfo) this.objectInfo = await this.client.objectInfo();
    return this.objectInfo;
  }

  /**
   * Check a request without running it: the recipe exists, is allowed, is
   * installed, and its parameters resolve. Routes call this before creating
   * a job, so a bad request is a 400 in milliseconds rather than a failed
   * job minutes later.
   */
  async prepareRequest(request: RecipeJobParams): Promise<{ recipe: Recipe; mode: string; values: ParamValues }> {
    const recipe = this.deps.recipes.require(request.recipe);
    const modeName = request.mode ?? recipe.default_mode;
    const mode = recipe.modes[modeName];
    if (!mode) {
      throw errors.validation(`Recipe "${recipe.id}" has no mode "${modeName}" (${Object.keys(recipe.modes).join(', ')})`);
    }
    const blocked = licenceBlock(recipe.licence, this.deps.config.licenceMode);
    if (blocked) throw proErrors.recipeLicence(`${blocked}; this server runs in commercial mode.`);
    const values = resolveParams(recipe, mode, request.params ?? {});
    await checkUploads(recipe, values, this.deps.paths.uploadsDir);
    const files = await this.deps.recipes.resolveFiles(recipe, this.deps.config.tier);
    const needed = this.filesNeeded(recipe, recipe.workflows[mode.workflow]);
    const missing = files.filter((f) => needed.has(f.file.id) && !f.installed).map((f) => `${f.file.folder}/${f.name}`);
    if (missing.length > 0) throw proErrors.recipeNotInstalled(recipe.id, missing);
    return { recipe, mode: modeName, values };
  }

  private filesNeeded(recipe: Recipe, workflow: WorkflowSpec): Set<string> {
    const bound = new Set(workflow.bindings.flatMap((b) => ('file' in b ? [b.file] : [])));
    return new Set(recipe.files.filter((f) => bound.has(f.id) || !f.optional).map((f) => f.id));
  }

  private async run(context: JobContext): Promise<Record<string, unknown>> {
    const request = context.job.params as unknown as RecipeJobParams;
    const started = Date.now();
    const { recipe, mode: modeName, values } = await this.prepareRequest(request);
    const mode = recipe.modes[modeName];
    const workflow = recipe.workflows[mode.workflow];

    return this.slot.run(async () => {
      try {
        await this.makeRoom(recipe, context.onLog);
        // A ComfyUI that was not running starts fresh: its node types are
        // re-read (the image may have gained a node pack) and nothing is loaded.
        if (!this.resident()) this.reset();
        const lease = await this.deps.backends.acquire('comfy', context.signal);
        if (!lease) throw errors.backendUnavailable('comfy', 'ComfyUI has nothing to serve');
        try {
          const prompt = buildPrompt({
            recipe,
            mode,
            workflow,
            template: this.deps.recipes.workflow(recipe, mode.workflow),
            values,
            files: await this.deps.recipes.resolveFiles(recipe, this.deps.config.tier),
            objectInfo: await this.nodeTypes(),
          });
          const outputs = await this.execute(prompt, workflow, context);
          this.family = recipe.family;
          this.jobsSinceStart++;

          const result = await this.collect(recipe, outputs, workflow);
          const first = result[0];
          return {
            [`${first.kind}_url`]: first.url,
            [`${first.kind}_path`]: first.path,
            outputs: result.map(({ path: _path, ...rest }) => rest),
            metadata: {
              kind: recipe.kind,
              recipe: recipe.id,
              recipe_version: recipe.version,
              mode: modeName,
              params: values,
              seed: values.seed,
              prompt: values.prompt,
              licence: recipe.licence.id,
              duration_ms: Date.now() - started,
              shot_id: request.shot_id,
              take_id: request.take_id,
              output_dir: this.deps.paths.outputDir,
            },
          };
        } finally {
          lease.release();
        }
      } finally {
        await this.afterJob();
      }
    }, context.signal);
  }

  private reset(): void {
    this.objectInfo = null;
    this.family = null;
    this.jobsSinceStart = 0;
  }

  /**
   * Before a job: hand the GPU to ComfyUI (llama.cpp is released unless the
   * card is big enough to keep both), and unload the previous recipe family's
   * models if this job uses different ones. Same family, next take: nothing
   * to do, which is the point of keeping ComfyUI warm.
   */
  private async makeRoom(recipe: Recipe, log: (line: string) => void): Promise<void> {
    if (this.deps.config.tier !== '96gb') await this.deps.memory.exclusive(this.id, log);
    if (this.family && this.family !== recipe.family && this.resident()) {
      log(`Unloading ${this.family} models for ${recipe.family}`);
      await this.client.free({ unloadModels: true, freeMemory: true }).catch(() => {});
      this.family = null;
    }
  }

  /** After a job: return memory when not keeping warm, and recycle a long-lived ComfyUI. */
  private async afterJob(): Promise<void> {
    if (!this.resident()) {
      this.reset();
      return;
    }
    const { comfyRecycleJobs, comfyKeepWarm } = this.deps.config;
    if (comfyRecycleJobs > 0 && this.jobsSinceStart >= comfyRecycleJobs) {
      this.deps.log.info({ jobs: this.jobsSinceStart }, 'recycling ComfyUI to return fragmented memory');
      await this.deps.backends.get('comfy')?.stop();
      this.reset();
      return;
    }
    if (!comfyKeepWarm) {
      await this.client.free({ unloadModels: true, freeMemory: true }).catch(() => {});
      this.family = null;
    }
  }

  /** Queue a prompt and follow it to the end; resolves to its history outputs. */
  private async execute(
    prompt: Prompt,
    workflow: WorkflowSpec,
    context: JobContext,
  ): Promise<Record<string, Record<string, unknown>>> {
    const watcher = await this.client.open();
    let promptId: string;
    try {
      promptId = await this.client.queue(prompt);
    } catch (err) {
      watcher.close();
      if (err instanceof PromptRejected) {
        const detail = Object.entries(err.nodeErrors)
          .map(([node, e]) => `${node} (${e.class_type}): ${(e.errors ?? []).map((x) => x.details || x.message).join('; ')}`)
          .join(' | ');
        throw errors.validation(`ComfyUI rejected the workflow: ${err.message}${detail ? ` — ${detail}` : ''}`, err.nodeErrors);
      }
      throw err;
    }
    context.onLog(`Queued on ComfyUI as ${promptId}`);

    const progress = new ProgressTracker(workflow.progress);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void this.client.interrupt().catch(() => {});
          reject(errors.processTimeout(this.deps.config.comfyTimeoutMs));
        }, this.deps.config.comfyTimeoutMs);
        const onAbort = () => {
          void this.client.dequeue(promptId).catch(() => {});
          void this.client.interrupt().catch(() => {});
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
        const finish = (err?: Error) => {
          clearTimeout(timer);
          context.signal.removeEventListener('abort', onAbort);
          if (err) reject(err);
          else resolve();
        };
        watcher.follow(promptId, (event: ExecutionEvent) => {
          switch (event.type) {
            case 'executing':
              if (event.node) context.onLog(`Running node ${event.node} (${prompt[event.node]?.class_type ?? '?'})`);
              break;
            case 'progress':
              context.onProgress(progress.update(event.node, event.value, event.max));
              break;
            case 'cached':
              progress.skip(event.nodes);
              break;
            case 'success':
              finish();
              break;
            case 'interrupted':
              finish(context.signal.aborted ? new Error('Cancelled') : errors.generationFailed('ComfyUI interrupted the job'));
              break;
            case 'error':
              for (const line of event.traceback?.slice(-12) ?? []) context.onLog(line.trimEnd());
              finish(this.mapError(event));
              break;
          }
        });
      });
    } finally {
      watcher.close();
    }

    const history = await this.client.history(promptId);
    if (!history) throw proErrors.engineFailed(`ComfyUI has no history for prompt ${promptId}`);
    return history.outputs;
  }

  private mapError(event: Extract<ExecutionEvent, { type: 'error' }>): AppError {
    const where = event.nodeType ? ` in ${event.nodeType} (node ${event.nodeId})` : '';
    if (OUT_OF_MEMORY.test(`${event.exceptionType} ${event.message}`)) {
      return proErrors.outOfMemory(
        `Out of memory${where}. Use a draft mode, a lower resolution or fewer seconds, or a larger tier.`,
      );
    }
    return proErrors.engineFailed(`${event.exceptionType ?? 'Error'}${where}: ${event.message}`, {
      node: event.nodeId,
      nodeType: event.nodeType,
      exceptionType: event.exceptionType,
    });
  }

  /** Move a job's files from ComfyUI's output folder into Pepper's outputs. */
  private async collect(
    recipe: Recipe,
    outputs: Record<string, Record<string, unknown>>,
    workflow: WorkflowSpec,
  ): Promise<{ kind: 'image' | 'video' | 'audio'; name: string; url: string; path: string }[]> {
    const collected: { kind: 'image' | 'video' | 'audio'; name: string; url: string; path: string }[] = [];
    await mkdir(this.deps.paths.outputDir, { recursive: true });
    for (const { node, kind } of workflow.outputs) {
      for (const file of outputFiles(outputs[node])) {
        const source = this.sourcePath(file);
        try {
          await stat(source);
        } catch {
          continue;
        }
        const name = uniqueOutputName(extname(file.filename).slice(1) || 'bin', recipe.id);
        const target = safeResolve(this.deps.paths.outputDir, name);
        await rename(source, target).catch(async () => {
          // Across filesystems (outputs on tmpfs, the cache on a volume) a
          // rename fails; copy then remove instead.
          await copyFile(source, target);
          await rm(source, { force: true });
        });
        collected.push({ kind, name, url: `/v1/outputs/${encodeURIComponent(name)}`, path: target });
      }
    }
    if (collected.length === 0) {
      throw proErrors.engineFailed('ComfyUI finished without writing an output file');
    }
    return collected;
  }

  private sourcePath(file: OutputFile): string {
    const base =
      file.type === 'temp' ? this.deps.paths.comfyTempDir : file.type === 'input' ? this.deps.paths.uploadsDir : this.deps.paths.comfyOutputDir;
    const dir = file.subfolder ? join(base, ...file.subfolder.split('/').map((s) => safeSegment(s))) : base;
    return safeResolve(dir, file.filename);
  }
}

function safeSegment(segment: string): string {
  if (!segment || segment === '.' || segment === '..' || segment.includes('\\')) {
    throw proErrors.engineFailed(`ComfyUI reported an unexpected output folder "${segment}"`);
  }
  return segment;
}

/** Files one output node reported, whatever key it used (images, gifs, videos, audio). */
export function outputFiles(output: Record<string, unknown> | undefined): OutputFile[] {
  if (!output) return [];
  const files: OutputFile[] = [];
  for (const value of Object.values(output)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as OutputFile).filename === 'string') {
        files.push(item as OutputFile);
      }
    }
  }
  return files;
}

/**
 * One progress bar from per-node step events. With weights, each weighted
 * node counts for its share and finished nodes stay counted; without, the bar
 * follows whichever node is sampling (what sd-cli jobs look like).
 */
export class ProgressTracker {
  private readonly done = new Set<string>();
  private current: string | null = null;

  constructor(private readonly weights?: Record<string, number>) {}

  skip(nodes: string[]): void {
    for (const node of nodes) if (this.weights?.[node]) this.done.add(node);
  }

  update(node: string, value: number, max: number): { step: number; total: number; progress: number } {
    const fraction = max > 0 ? Math.min(1, value / max) : 0;
    if (!this.weights || !this.weights[node]) return { step: value, total: max, progress: fraction };
    if (this.current && this.current !== node) this.done.add(this.current);
    this.current = node;
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0);
    const finished = [...this.done].reduce((sum, id) => sum + (this.weights![id] ?? 0), 0);
    return { step: value, total: max, progress: Math.min(1, (finished + fraction * this.weights[node]) / total) };
  }
}
