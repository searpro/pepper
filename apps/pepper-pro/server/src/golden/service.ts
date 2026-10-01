import { randomInt } from 'node:crypto';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Db } from '@pepper/core/db/client.js';
import { errors } from '@pepper/core/errors.js';
import type { Job, JobManager } from '@pepper/core/jobs/manager.js';
import { safeResolve, safeResolveNested } from '@pepper/core/paths.js';
import type { ProConfig } from '../config.js';
import type { ComfyEngine } from '../engines/comfy.js';
import type { ProPaths } from '../paths.js';
import { newId } from '../projects/service.js';
import type { Recipe } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import { goldenResults, goldenRuns, goldenVotes, type GoldenResultRow, type GoldenRunRow } from './schema.js';

/**
 * Golden shots (docs/PEPPER-PRO.md §9.4): how "this recipe version is
 * better" becomes a record instead of an impression.
 *
 * A run renders every golden shot a recipe can take, with each shot's fixed
 * seed. The inputs those shots need (portraits, a product, a song, a driving
 * video) are made once by whichever installed recipe has the capability and
 * then kept, so every version of every recipe sees the same inputs; only a
 * voice recording has to be supplied. Results are kept per recipe version,
 * and the Recipes screen compares two versions shot by shot, blind.
 */

const inputSchema = z.object({
  kind: z.enum(['image', 'audio', 'video']),
  generate: z
    .object({
      capability: z.string(),
      prompt: z.string(),
      params: z.record(z.unknown()).default({}),
      seed: z.number().int(),
      /** The recipe mode to make it in; its final mode, else its default. */
      mode: z.string().optional(),
    })
    .optional(),
  /** A file the user puts in DATA_DIR/golden/inputs/. */
  supply: z.string().optional(),
  note: z.string().optional(),
});

const shotSchema = z.object({
  id: z.string(),
  target: z.string(),
  kind: z.enum(['image', 'video', 'audio']),
  capabilities: z.array(z.string()).min(1),
  seed: z.number().int(),
  prompt: z.string(),
  motion: z.string().optional(),
  inputs: z
    .object({
      image: z.string().optional(),
      last: z.string().optional(),
      refs: z.array(z.string()).optional(),
      audio: z.string().optional(),
      /** A second speaker's line (two-person talking recipes). */
      audio_2: z.string().optional(),
      /** A voice to clone (speech recipes). */
      voice: z.string().optional(),
      video: z.string().optional(),
      reference: z.string().optional(),
    })
    .default({}),
  params: z.record(z.unknown()).default({}),
});

export const goldenFileSchema = z
  .object({ about: z.string().optional(), inputs: z.record(inputSchema), shots: z.array(shotSchema) })
  .superRefine((file, ctx) => {
    for (const shot of file.shots) {
      const named = [shot.inputs.image, shot.inputs.last, shot.inputs.audio, shot.inputs.audio_2, shot.inputs.voice, shot.inputs.video, shot.inputs.reference, ...(shot.inputs.refs ?? [])];
      for (const name of named) {
        if (name && !file.inputs[name]) ctx.addIssue({ code: 'custom', message: `shot ${shot.id} uses unknown input "${name}"` });
      }
    }
  });

export type GoldenFile = z.infer<typeof goldenFileSchema>;
export type GoldenShot = GoldenFile['shots'][number];

export interface GoldenServiceDeps {
  db: Db;
  jobs: JobManager;
  comfy: ComfyEngine;
  recipes: RecipeStore;
  paths: ProPaths;
  config: ProConfig;
  log: FastifyBaseLogger;
  /** The shot list; golden/shots.json next to the recipes by default. */
  file: string;
}

/**
 * A golden shot's inputs, as a recipe's parameters. Mapped by name like a
 * project shot's (projects/derive.ts): only parameters the recipe declares
 * are set, and a recipe that requires one the shot cannot give skips it.
 */
export function goldenParams(recipe: Recipe, shot: GoldenShot, uploads: Record<string, string>): { params: Record<string, unknown> } | { skip: string } {
  const has = (name: string) => recipe.params.find((p) => p.name === name);
  const out: Record<string, unknown> = {};
  const put = (names: string[], value: unknown) => {
    const name = names.find((n) => has(n));
    if (name && value !== undefined) out[name] = value;
  };
  const one = (key?: string) => (key ? uploads[key] : undefined);
  put(['prompt'], shot.prompt);
  put(['motion'], shot.motion);
  put(['image', 'first_frame'], one(shot.inputs.image));
  put(['last_frame'], one(shot.inputs.last));
  put(['refs', 'reference_images', 'images'], shot.inputs.refs?.map((r) => uploads[r]));
  put(['audio'], one(shot.inputs.audio));
  put(['audio_2'], one(shot.inputs.audio_2));
  put(['voice_ref'], one(shot.inputs.voice));
  put(['video'], one(shot.inputs.video));
  put(['reference'], one(shot.inputs.reference));
  for (const [key, value] of Object.entries(shot.params)) put([key], value);
  if (has('seed')) out.seed = shot.seed;
  // A list parameter takes at most its slots.
  for (const param of recipe.params) {
    if (Array.isArray(out[param.name]) && param.max_items) out[param.name] = (out[param.name] as unknown[]).slice(0, param.max_items);
  }
  const missing = recipe.params.filter((p) => p.required && out[p.name] === undefined).map((p) => p.name);
  return missing.length ? { skip: `the shot has no ${missing.join(', ')} for this recipe` } : { params: out };
}

export class GoldenService {
  private file: GoldenFile = { inputs: {}, shots: [] };
  /** Inputs being generated, so two runs share one job per input. */
  private readonly making = new Map<string, Promise<string>>();

  constructor(private readonly deps: GoldenServiceDeps) {
    deps.jobs.on('completed', (job: Job) => void this.onJobSettled(job));
    deps.jobs.on('failed', (job: Job) => void this.onJobSettled(job));
  }

  async load(): Promise<void> {
    try {
      this.file = goldenFileSchema.parse(JSON.parse(await readFile(this.deps.file, 'utf8')));
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message, file: this.deps.file }, 'golden shots failed to load');
    }
    // A run's orchestration lives in this process; one left mid-way by a
    // restart will never finish, so say so rather than show it running.
    this.deps.db
      .update(goldenRuns)
      .set({ status: 'failed', error: 'interrupted by a restart', finishedAt: Date.now() })
      .where(eq(goldenRuns.status, 'preparing'))
      .run();
  }

  get shots(): GoldenShot[] {
    return this.file.shots;
  }

  get inputs(): GoldenFile['inputs'] {
    return this.file.inputs;
  }

  /** The golden shots a recipe can take. */
  applicable(recipe: Recipe): GoldenShot[] {
    return this.file.shots.filter((shot) => shot.kind === recipe.kind && shot.capabilities.some((c) => recipe.capabilities.includes(c)));
  }

  private get dir(): string {
    return join(this.deps.paths.dataDir, 'golden');
  }

  // --- Runs ------------------------------------------------------------------

  listRuns(recipeId?: string): (GoldenRunRow & { results: GoldenResultRow[] })[] {
    const runs = this.deps.db
      .select()
      .from(goldenRuns)
      .where(recipeId ? eq(goldenRuns.recipeId, recipeId) : undefined)
      .orderBy(desc(goldenRuns.createdAt))
      .all();
    return runs.map((run) => ({ ...run, results: this.deps.db.select().from(goldenResults).where(eq(goldenResults.runId, run.id)).all() }));
  }

  /** Start a run; inputs are made and shots queued in the background. */
  start(recipeId: string, mode?: string): GoldenRunRow {
    const recipe = this.deps.recipes.require(recipeId);
    // Golden shots judge what ships, so a recipe's final mode is the default.
    const modeName = mode ?? (recipe.modes.final ? 'final' : recipe.default_mode);
    if (!recipe.modes[modeName]) throw errors.validation(`Recipe "${recipe.id}" has no mode "${modeName}"`);
    const shots = this.applicable(recipe);
    if (shots.length === 0) throw errors.validation(`No golden shot fits ${recipe.id} (${recipe.kind}: ${recipe.capabilities.join(', ')})`);
    const run: GoldenRunRow = {
      id: newId('gld'),
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      mode: modeName,
      status: 'preparing',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.deps.db.insert(goldenRuns).values(run).run();
    for (const shot of shots) {
      this.deps.db
        .insert(goldenResults)
        .values({ id: newId('gre'), runId: run.id, shotId: shot.id, jobId: null, status: 'queued', file: null, error: null, review: null })
        .run();
    }
    void this.orchestrate(run, recipe, shots).catch((err: Error) => {
      this.deps.log.error({ err: err.message, run: run.id }, 'golden run failed');
      this.deps.db.update(goldenRuns).set({ status: 'failed', error: err.message, finishedAt: Date.now() }).where(eq(goldenRuns.id, run.id)).run();
    });
    return run;
  }

  private async orchestrate(run: GoldenRunRow, recipe: Recipe, shots: GoldenShot[]): Promise<void> {
    for (const shot of shots) {
      const result = this.deps.db
        .select()
        .from(goldenResults)
        .where(and(eq(goldenResults.runId, run.id), eq(goldenResults.shotId, shot.id)))
        .get()!;
      const skip = (why: string) =>
        this.deps.db.update(goldenResults).set({ status: 'skipped', error: why }).where(eq(goldenResults.id, result.id)).run();
      try {
        const uploads: Record<string, string> = {};
        const names = [shot.inputs.image, shot.inputs.last, shot.inputs.audio, shot.inputs.audio_2, shot.inputs.voice, shot.inputs.video, shot.inputs.reference, ...(shot.inputs.refs ?? [])];
        for (const name of names) if (name && !uploads[name]) uploads[name] = await this.input(name);
        const mapped = goldenParams(recipe, shot, uploads);
        if ('skip' in mapped) {
          skip(mapped.skip);
          continue;
        }
        const prepared = await this.deps.comfy.prepareRequest({ recipe: recipe.id, mode: run.mode, params: mapped.params });
        const job = this.deps.jobs.create(recipe.kind, {
          recipe: recipe.id,
          mode: prepared.mode,
          params: prepared.values,
          golden_run: run.id,
          golden_shot: shot.id,
        });
        this.deps.db.update(goldenResults).set({ jobId: job.id, status: 'running' }).where(eq(goldenResults.id, result.id)).run();
      } catch (err) {
        skip((err as Error).message);
      }
    }
    this.deps.db.update(goldenRuns).set({ status: 'rendering' }).where(eq(goldenRuns.id, run.id)).run();
    this.finishIfDone(run.id);
  }

  /**
   * A golden input as an upload name: made once, then reused by every run.
   * Uploads are ComfyUI's input folder, which is where a recipe reads from.
   */
  private async input(name: string): Promise<string> {
    const spec = this.file.inputs[name];
    const upload = (ext: string) => `golden-${name}${ext}`;
    if (spec.supply) {
      const target = upload(extname(spec.supply));
      const source = join(this.dir, 'inputs', spec.supply);
      try {
        await access(source);
      } catch {
        throw new Error(`put ${spec.note ? `${spec.note} ` : ''}at ${source}`);
      }
      await copyFile(source, safeResolve(this.deps.paths.uploadsDir, target));
      return target;
    }
    const ext = spec.kind === 'image' ? '.png' : spec.kind === 'audio' ? '.flac' : '.mp4';
    const existing = upload(ext);
    try {
      await access(safeResolve(this.deps.paths.uploadsDir, existing));
      return existing;
    } catch {
      // Not made yet.
    }
    const making = this.making.get(name) ?? this.generate(name, existing);
    this.making.set(name, making);
    try {
      return await making;
    } finally {
      this.making.delete(name);
    }
  }

  private async generate(name: string, target: string): Promise<string> {
    const spec = this.file.inputs[name].generate!;
    const kind = this.file.inputs[name].kind;
    const candidates: Recipe[] = [];
    for (const recipe of this.deps.recipes.list()) {
      if (recipe.kind !== kind || !recipe.capabilities.includes(spec.capability)) continue;
      const status = await this.deps.recipes.status(recipe, this.deps.config.tier, this.deps.config.licenceMode);
      if (status.state === 'installed' && !status.licenceBlock) candidates.push(recipe);
    }
    // Permissively licensed first, so inputs made on one server are usable anywhere.
    const recipe = candidates.sort((a, b) => Number(b.licence.commercial === 'yes') - Number(a.licence.commercial === 'yes'))[0];
    if (!recipe) throw new Error(`input "${name}" needs an installed ${kind} recipe with ${spec.capability}`);
    const mode = spec.mode && recipe.modes[spec.mode] ? spec.mode : recipe.modes.final ? 'final' : recipe.default_mode;
    const params: Record<string, unknown> = { ...spec.params, prompt: spec.prompt, seed: spec.seed };
    for (const key of Object.keys(params)) if (!recipe.params.some((p) => p.name === key)) delete params[key];
    const prepared = await this.deps.comfy.prepareRequest({ recipe: recipe.id, mode, params });
    const job = this.deps.jobs.create(kind, { recipe: recipe.id, mode: prepared.mode, params: prepared.values, golden_input: name });
    const done = await this.settle(job.id);
    const result = (done.result ?? {}) as Record<string, unknown>;
    const path = result[`${kind}_path`] as string | undefined;
    if (done.status !== 'completed' || !path) throw new Error(`making input "${name}" with ${recipe.id} failed: ${done.error?.message ?? done.status}`);
    const named = target.replace(/\.[^.]+$/, extname(path));
    await copyFile(path, safeResolve(this.deps.paths.uploadsDir, named));
    this.deps.log.info({ input: name, recipe: recipe.id }, 'golden input made');
    return named;
  }

  private settle(id: string): Promise<Job> {
    return new Promise((resolve) => {
      const check = () => {
        const job = this.deps.jobs.get(id);
        if (!job || !['queued', 'running'].includes(job.status)) {
          this.deps.jobs.off('updated', onUpdate);
          resolve(job ?? ({ status: 'failed', error: { code: 'GONE', message: 'job removed' } } as unknown as Job));
        }
      };
      const onUpdate = (job: Job) => job.id === id && check();
      this.deps.jobs.on('updated', onUpdate);
      check();
    });
  }

  private async onJobSettled(job: Job): Promise<void> {
    const check = job.params as { task?: string; golden_result?: string };
    if (job.kind === 'analyze' && check.golden_result) {
      const match = (job.result as { match?: { wer: number; ok: boolean }; text?: string } | undefined) ?? {};
      const review = match.match
        ? { ok: match.match.ok, wer: match.match.wer, heard: match.text, by: 'whisper-base' }
        : { ok: false, error: job.error?.message ?? job.status, by: 'whisper-base' };
      this.deps.db.update(goldenResults).set({ review }).where(eq(goldenResults.id, check.golden_result)).run();
      return;
    }
    const params = job.params as { golden_run?: string; golden_shot?: string; recipe?: string; mode?: string; params?: { text?: string } };
    if (!params.golden_run || !params.golden_shot) return;
    const run = this.deps.db.select().from(goldenRuns).where(eq(goldenRuns.id, params.golden_run)).get();
    const result = this.deps.db.select().from(goldenResults).where(eq(goldenResults.jobId, job.id)).get();
    if (!run || !result) return;
    const path = (job.result as Record<string, unknown> | undefined)?.[`${job.kind}_path`] as string | undefined;
    if (job.status === 'completed' && path) {
      const file = join(run.recipeId, `v${run.recipeVersion}`, run.mode, `${params.golden_shot}${extname(path)}`);
      await mkdir(join(this.dir, run.recipeId, `v${run.recipeVersion}`, run.mode), { recursive: true });
      await copyFile(path, join(this.dir, file));
      this.deps.db.update(goldenResults).set({ status: 'completed', file }).where(eq(goldenResults.id, result.id)).run();
      // Speech is checked by ear, automatically: a speech model now and then
      // returns noise for a seed that worked before, and a blind vote should
      // not be spent on a take that says nothing.
      const text = params.params?.text;
      if (job.kind === 'audio' && typeof text === 'string' && text.trim()) {
        this.deps.jobs.create('analyze', { task: 'transcribe', golden_file: file, expected: text, golden_result: result.id });
      }
    } else {
      this.deps.db
        .update(goldenResults)
        .set({ status: 'failed', error: job.error?.message ?? job.status })
        .where(eq(goldenResults.id, result.id))
        .run();
    }
    this.finishIfDone(run.id);
  }

  private finishIfDone(runId: string): void {
    const run = this.deps.db.select().from(goldenRuns).where(eq(goldenRuns.id, runId)).get();
    if (!run || run.status !== 'rendering') return;
    const results = this.deps.db.select().from(goldenResults).where(eq(goldenResults.runId, runId)).all();
    if (results.some((r) => r.status === 'queued' || r.status === 'running')) return;
    this.deps.db.update(goldenRuns).set({ status: 'done', finishedAt: Date.now() }).where(eq(goldenRuns.id, runId)).run();
  }

  /** A kept result file, for serving. */
  resultPath(file: string): string {
    return safeResolveNested(this.dir, ...file.split('/'));
  }

  // --- Blind comparison ------------------------------------------------------

  /** The latest completed result of each shot, per version, for one recipe and mode. */
  private latest(recipeId: string, mode: string): Map<number, Map<string, string>> {
    const byVersion = new Map<number, Map<string, string>>();
    const runs = this.listRuns(recipeId).filter((r) => r.mode === mode).reverse();
    for (const run of runs) {
      const shots = byVersion.get(run.recipeVersion) ?? new Map<string, string>();
      for (const result of run.results) if (result.status === 'completed' && result.file) shots.set(result.shotId, result.file);
      byVersion.set(run.recipeVersion, shots);
    }
    return byVersion;
  }

  /**
   * A shot rendered by two versions, sides shuffled. The versions come back
   * only with the vote, so the choice is made on the pictures.
   */
  pair(recipeId: string, mode: string, a?: number, b?: number) {
    const byVersion = this.latest(recipeId, mode);
    const versions = [...byVersion.keys()].sort((x, y) => y - x);
    const newer = a ?? versions[0];
    const older = b ?? versions.find((v) => v !== newer);
    if (newer === undefined || older === undefined) return null;
    const left = byVersion.get(newer)!;
    const right = byVersion.get(older)!;
    const voted = new Set(
      this.deps.db
        .select()
        .from(goldenVotes)
        .where(and(eq(goldenVotes.recipeId, recipeId), eq(goldenVotes.mode, mode)))
        .all()
        .filter((v) => (v.versionA === newer && v.versionB === older) || (v.versionA === older && v.versionB === newer))
        .map((v) => v.shotId),
    );
    const shots = [...left.keys()].filter((shot) => right.has(shot) && !voted.has(shot));
    if (shots.length === 0) return { done: true as const, versions: [newer, older] };
    const shot = shots[randomInt(shots.length)];
    const flip = randomInt(2) === 1;
    const sides = flip ? [older, newer] : [newer, older];
    return {
      done: false as const,
      shot,
      remaining: shots.length,
      left: { file: byVersion.get(sides[0])!.get(shot)!, token: Buffer.from(String(sides[0])).toString('base64') },
      right: { file: byVersion.get(sides[1])!.get(shot)!, token: Buffer.from(String(sides[1])).toString('base64') },
    };
  }

  vote(input: { recipe: string; mode: string; shot: string; left: string; right: string; winner: 'left' | 'right' | 'tie' }) {
    const decode = (token: string) => Number(Buffer.from(token, 'base64').toString());
    const left = decode(input.left);
    const right = decode(input.right);
    if (!Number.isInteger(left) || !Number.isInteger(right)) throw errors.validation('Bad comparison tokens');
    const winner = input.winner === 'tie' ? null : input.winner === 'left' ? left : right;
    this.deps.db
      .insert(goldenVotes)
      .values({ id: newId('gvt'), recipeId: input.recipe, shotId: input.shot, mode: input.mode, versionA: left, versionB: right, winner, createdAt: Date.now() })
      .run();
    return { left, right, winner };
  }

  /** Wins, losses and ties of each version against the others. */
  tally(recipeId: string) {
    const votes = this.deps.db.select().from(goldenVotes).where(eq(goldenVotes.recipeId, recipeId)).all();
    const table = new Map<number, { wins: number; losses: number; ties: number }>();
    const row = (v: number) => table.get(v) ?? (table.set(v, { wins: 0, losses: 0, ties: 0 }), table.get(v)!);
    for (const vote of votes) {
      if (vote.winner === null) {
        row(vote.versionA).ties++;
        row(vote.versionB).ties++;
      } else {
        row(vote.winner).wins++;
        row(vote.winner === vote.versionA ? vote.versionB : vote.versionA).losses++;
      }
    }
    return [...table.entries()].map(([version, counts]) => ({ version, ...counts })).sort((a, b) => b.version - a.version);
  }
}
