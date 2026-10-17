import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@pepper/core/db/client.js';
import { errors } from '@pepper/core/errors.js';
import type { Job, JobManager } from '@pepper/core/jobs/manager.js';
import { safeResolve } from '@pepper/core/paths.js';
import type { LicenceMode, ProConfig } from '../config.js';
import type { ComfyEngine, RecipeJobParams } from '../engines/comfy.js';
import { proErrors } from '../errors.js';
import type { ProPaths } from '../paths.js';
import { probeMedia, runFfmpeg } from '@pepper/core/util/ffmpeg.js';
import type { Recipe, RecipeParam } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import { joinArgs, planSegments, type JoinPart, type TakeChain } from './chain.js';
import { composePrompt, deriveParams } from './derive.js';
import {
  assets,
  cuts,
  projects,
  scenes,
  shots,
  takes,
  type AssetRow,
  type CutRow,
  type ProjectRow,
  type SceneRow,
  type ShotRow,
  type TakeRow,
} from './schema.js';

/**
 * Projects, assets, scenes, shots, takes and cuts (docs/PEPPER-PRO.md §8).
 *
 * Rows are the source of truth for structure; a take's status is its job's.
 * When a take's job completes, its output is copied into
 * `DATA_DIR/projects/<id>/takes/`, because outputs are swept after a day and
 * a cut assembled next week still needs its footage.
 */

export interface ProjectServiceDeps {
  db: Db;
  jobs: JobManager;
  comfy: ComfyEngine;
  recipes: RecipeStore;
  paths: ProPaths;
  config: ProConfig;
  log: FastifyBaseLogger;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Only the fields a caller may set; ids, positions and timestamps are the service's. */
export type ProjectInput = Partial<Pick<ProjectRow, 'name' | 'description' | 'aspect' | 'fps' | 'style' | 'lut' | 'licenceMode' | 'script'>>;
export type AssetInput = Partial<Pick<AssetRow, 'kind' | 'name' | 'description' | 'images' | 'voice' | 'audio' | 'meta'>>;
export type SceneInput = Partial<Pick<SceneRow, 'title' | 'notes'>>;
export type ShotInput = Partial<
  Pick<
    ShotRow,
    | 'kind'
    | 'durationS'
    | 'framing'
    | 'camera'
    | 'prompt'
    | 'dialogue'
    | 'sound'
    | 'assetIds'
    | 'keyframes'
    | 'audioAssetId'
    | 'recipeId'
    | 'params'
    | 'continues'
  >
>;
export type CutInput = Partial<Pick<CutRow, 'name' | 'items' | 'music' | 'subtitles' | 'beatSync'>>;

/** A plan as Claude (or the Script screen) writes it: assets by reference, scenes of shots. */
export interface PlanInput {
  script?: string;
  style?: string;
  /** Replace the project's scenes and shots rather than appending. */
  replace?: boolean;
  assets?: { ref: string; kind: AssetRow['kind']; name: string; description?: string; images?: string[]; audio?: string; voice?: { upload?: string; description?: string } }[];
  scenes: {
    title?: string;
    notes?: string;
    shots: {
      kind?: ShotRow['kind'];
      duration_s?: number;
      framing?: string;
      camera?: string;
      prompt: string;
      /** `speaker` is an asset ref, an existing asset id, or a name. */
      dialogue?: { speaker: string; line: string; language?: string }[];
      sound?: string;
      /** Asset refs or ids. */
      assets?: string[];
      audio?: string;
      recipe?: string;
      params?: Record<string, unknown>;
      continues?: boolean;
    }[];
  }[];
}

/** What a vision model made of a take, against its shot. */
export interface TakeReview {
  ok: boolean;
  /** 0-5, how well the take matches the shot. */
  score: number;
  issues: string[];
  model: string;
  at: number;
}

/** A take mastered for delivery (see `masterTake`). */
export interface TakeMaster {
  jobId: string;
  recipe: string;
  state: 'rendering' | 'done' | 'failed';
  /** The mastered file, in the project's files. */
  file?: string;
  error?: string;
}

export interface TakeView extends Omit<TakeRow, 'chain' | 'master'> {
  chain: TakeChain | null;
  master: (TakeMaster & { url?: string; status?: Job['status']; progress?: number }) | null;
  status: Job['status'] | 'missing';
  progress: number;
  error?: Job['error'];
  url?: string;
  kind?: 'image' | 'video' | 'audio';
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {
    // A failed or cancelled segment ends its chain; `failed` covers both.
    deps.jobs.on('completed', (job: Job) => void this.onJobSettled(job));
    deps.jobs.on('failed', (job: Job) => void this.onJobSettled(job));
    void this.resumeChains();
  }

  /**
   * Chains whose segment settled while the server was down (or was stopped
   * with it) are advanced or failed now; a join cut short is failed, since
   * its segments are still in uploads and a retake is one click.
   */
  private async resumeChains(): Promise<void> {
    try {
      for (const take of this.db.select().from(takes).all()) {
        const chain = take.chain as TakeChain | null;
        if (!chain || chain.state === 'done' || chain.state === 'failed') continue;
        if (chain.state === 'joining') {
          this.setChain(take.id, { ...chain, state: 'failed', error: 'The server stopped while joining the segments' });
          continue;
        }
        const job = this.deps.jobs.get(take.jobId);
        if (!job) {
          this.setChain(take.id, { ...chain, state: 'failed', error: `Segment ${chain.index + 1}'s job is gone` });
        } else if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          await this.onJobSettled(job);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'could not resume long takes');
    }
  }

  private get db(): Db {
    return this.deps.db;
  }

  // --- Projects --------------------------------------------------------------

  listProjects(): ProjectRow[] {
    return this.db.select().from(projects).orderBy(desc(projects.updatedAt)).all();
  }

  requireProject(id: string): ProjectRow {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw proErrors.projectNotFound(id);
    return row;
  }

  createProject(input: ProjectInput & { name: string }): ProjectRow {
    const now = Date.now();
    const row = {
      id: newId('prj'),
      name: input.name,
      description: input.description ?? '',
      aspect: input.aspect ?? '9:16',
      fps: input.fps ?? 24,
      style: input.style ?? '',
      lut: input.lut ?? null,
      licenceMode: input.licenceMode ?? this.deps.config.licenceMode,
      script: input.script ?? '',
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(projects).values(row).run();
    return row;
  }

  updateProject(id: string, input: ProjectInput): ProjectRow {
    this.requireProject(id);
    this.db.update(projects).set({ ...input, updatedAt: Date.now() }).where(eq(projects.id, id)).run();
    return this.requireProject(id);
  }

  private touch(projectId: string): void {
    this.db.update(projects).set({ updatedAt: Date.now() }).where(eq(projects.id, projectId)).run();
  }

  async deleteProject(id: string): Promise<void> {
    this.requireProject(id);
    this.db.delete(takes).where(eq(takes.projectId, id)).run();
    this.db.delete(shots).where(eq(shots.projectId, id)).run();
    this.db.delete(scenes).where(eq(scenes.projectId, id)).run();
    this.db.delete(cuts).where(eq(cuts.projectId, id)).run();
    this.db.delete(assets).where(eq(assets.projectId, id)).run();
    this.db.delete(projects).where(eq(projects.id, id)).run();
    await rm(safeResolve(this.deps.paths.projectsDir, id), { recursive: true, force: true });
  }

  // --- Assets ----------------------------------------------------------------

  /** A project's assets plus the shared library. */
  listAssets(projectId: string | null): AssetRow[] {
    const where = projectId ? or(eq(assets.projectId, projectId), isNull(assets.projectId)) : isNull(assets.projectId);
    return this.db.select().from(assets).where(where).orderBy(asc(assets.createdAt)).all();
  }

  requireAsset(id: string): AssetRow {
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw errors.validation(`Asset not found: ${id}`);
    return row;
  }

  createAsset(projectId: string | null, input: AssetInput & { name: string; kind: AssetRow['kind'] }): AssetRow {
    if (projectId) this.requireProject(projectId);
    const now = Date.now();
    const row: AssetRow = {
      id: newId('ast'),
      projectId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? '',
      images: input.images ?? [],
      voice: input.voice ?? null,
      audio: input.audio ?? null,
      meta: input.meta ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(assets).values(row).run();
    if (projectId) this.touch(projectId);
    return row;
  }

  updateAsset(id: string, input: AssetInput): AssetRow {
    this.requireAsset(id);
    this.db.update(assets).set({ ...input, updatedAt: Date.now() }).where(eq(assets.id, id)).run();
    return this.requireAsset(id);
  }

  deleteAsset(id: string): void {
    this.requireAsset(id);
    this.db.delete(assets).where(eq(assets.id, id)).run();
  }

  // --- Scenes and shots ------------------------------------------------------

  listScenes(projectId: string): SceneRow[] {
    return this.db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.position)).all();
  }

  requireScene(id: string): SceneRow {
    const row = this.db.select().from(scenes).where(eq(scenes.id, id)).get();
    if (!row) throw errors.validation(`Scene not found: ${id}`);
    return row;
  }

  createScene(projectId: string, input: SceneInput = {}): SceneRow {
    this.requireProject(projectId);
    const position = this.listScenes(projectId).length;
    const now = Date.now();
    const row = { id: newId('scn'), projectId, position, title: input.title ?? '', notes: input.notes ?? '', createdAt: now, updatedAt: now };
    this.db.insert(scenes).values(row).run();
    this.touch(projectId);
    return row;
  }

  updateScene(id: string, input: SceneInput): SceneRow {
    const scene = this.requireScene(id);
    this.db.update(scenes).set({ ...input, updatedAt: Date.now() }).where(eq(scenes.id, id)).run();
    this.touch(scene.projectId);
    return this.requireScene(id);
  }

  deleteScene(id: string): void {
    const scene = this.requireScene(id);
    const ids = this.listShots(scene.projectId, id).map((s) => s.id);
    if (ids.length) {
      this.db.delete(takes).where(inArray(takes.shotId, ids)).run();
      this.db.delete(shots).where(inArray(shots.id, ids)).run();
    }
    this.db.delete(scenes).where(eq(scenes.id, id)).run();
    this.renumber(scene.projectId);
  }

  listShots(projectId: string, sceneId?: string): ShotRow[] {
    const where = sceneId ? and(eq(shots.projectId, projectId), eq(shots.sceneId, sceneId)) : eq(shots.projectId, projectId);
    return this.db.select().from(shots).where(where).orderBy(asc(shots.position)).all();
  }

  requireShot(id: string): ShotRow {
    const row = this.db.select().from(shots).where(eq(shots.id, id)).get();
    if (!row) throw proErrors.shotNotFound(id);
    return row;
  }

  createShot(sceneId: string, input: ShotInput = {}): ShotRow {
    const scene = this.requireScene(sceneId);
    if (input.recipeId) this.deps.recipes.require(input.recipeId);
    const position = this.listShots(scene.projectId, sceneId).length;
    const now = Date.now();
    const row: ShotRow = {
      id: newId('sht'),
      projectId: scene.projectId,
      sceneId,
      position,
      kind: input.kind ?? 'action',
      durationS: input.durationS ?? 5,
      framing: input.framing ?? '',
      camera: input.camera ?? '',
      prompt: input.prompt ?? '',
      dialogue: input.dialogue ?? [],
      sound: input.sound ?? '',
      assetIds: input.assetIds ?? [],
      keyframes: input.keyframes ?? {},
      audioAssetId: input.audioAssetId ?? null,
      recipeId: input.recipeId ?? null,
      params: input.params ?? {},
      continues: input.continues ?? false,
      chosenTakeId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(shots).values(row).run();
    this.touch(scene.projectId);
    return row;
  }

  updateShot(id: string, input: ShotInput & { sceneId?: string; position?: number }): ShotRow {
    const shot = this.requireShot(id);
    if (input.recipeId) this.deps.recipes.require(input.recipeId);
    const { position, ...fields } = input;
    this.db.update(shots).set({ ...fields, updatedAt: Date.now() }).where(eq(shots.id, id)).run();
    if (position !== undefined || input.sceneId) this.move(id, input.sceneId ?? shot.sceneId, position ?? Number.MAX_SAFE_INTEGER);
    this.touch(shot.projectId);
    return this.requireShot(id);
  }

  /** Put a shot at `position` in `sceneId`, renumbering both scenes. */
  private move(id: string, sceneId: string, position: number): void {
    const shot = this.requireShot(id);
    const order = this.listShots(shot.projectId, sceneId).filter((s) => s.id !== id);
    order.splice(Math.max(0, Math.min(position, order.length)), 0, { ...shot, sceneId });
    order.forEach((s, index) => {
      this.db.update(shots).set({ sceneId, position: index }).where(eq(shots.id, s.id)).run();
    });
    this.renumber(shot.projectId);
  }

  private renumber(projectId: string): void {
    this.listScenes(projectId).forEach((scene, index) => {
      this.db.update(scenes).set({ position: index }).where(eq(scenes.id, scene.id)).run();
      this.listShots(projectId, scene.id).forEach((shot, shotIndex) => {
        this.db.update(shots).set({ position: shotIndex }).where(eq(shots.id, shot.id)).run();
      });
    });
  }

  deleteShot(id: string): void {
    const shot = this.requireShot(id);
    this.db.delete(takes).where(eq(takes.shotId, id)).run();
    this.db.delete(shots).where(eq(shots.id, id)).run();
    this.renumber(shot.projectId);
  }

  // --- Planning --------------------------------------------------------------

  /**
   * Apply a whole plan: create its assets, then its scenes and shots, with
   * asset refs resolved. What `plan_project` sends, so Claude writes one
   * structured document instead of making forty calls.
   */
  plan(projectId: string, plan: PlanInput): { assets: AssetRow[]; scenes: SceneRow[]; shots: ShotRow[] } {
    const project = this.requireProject(projectId);
    for (const shot of plan.scenes.flatMap((s) => s.shots)) {
      if (shot.recipe) this.deps.recipes.require(shot.recipe);
    }
    if (plan.script !== undefined || plan.style !== undefined) {
      this.updateProject(projectId, {
        ...(plan.script !== undefined ? { script: plan.script } : {}),
        ...(plan.style !== undefined ? { style: plan.style } : {}),
      });
    }
    if (plan.replace) {
      for (const scene of this.listScenes(projectId)) this.deleteScene(scene.id);
    }

    const byRef = new Map<string, AssetRow>();
    for (const asset of this.listAssets(projectId)) {
      byRef.set(asset.id, asset);
      byRef.set(asset.name.toLowerCase(), asset);
    }
    const created: AssetRow[] = [];
    for (const input of plan.assets ?? []) {
      const existing = byRef.get(input.name.toLowerCase());
      const asset =
        existing && existing.kind === input.kind
          ? this.updateAsset(existing.id, {
              description: input.description ?? existing.description,
              ...(input.images ? { images: input.images } : {}),
              ...(input.audio ? { audio: input.audio } : {}),
              ...(input.voice ? { voice: input.voice } : {}),
            })
          : this.createAsset(project.id, {
              kind: input.kind,
              name: input.name,
              description: input.description,
              images: input.images,
              audio: input.audio,
              voice: input.voice,
            });
      created.push(asset);
      byRef.set(input.ref, asset);
      byRef.set(input.name.toLowerCase(), asset);
    }
    const resolve = (ref: string): AssetRow | undefined => byRef.get(ref) ?? byRef.get(ref.toLowerCase());

    const newScenes: SceneRow[] = [];
    const newShots: ShotRow[] = [];
    for (const sceneInput of plan.scenes) {
      const scene = this.createScene(projectId, { title: sceneInput.title, notes: sceneInput.notes });
      newScenes.push(scene);
      for (const s of sceneInput.shots) {
        const dialogue = (s.dialogue ?? []).map((d): { asset_id?: string; speaker?: string; line: string; language?: string } => {
          const asset = resolve(d.speaker);
          const language = d.language ? { language: d.language } : {};
          return asset ? { asset_id: asset.id, line: d.line, ...language } : { speaker: d.speaker, line: d.line, ...language };
        });
        const assetIds = (s.assets ?? []).map((ref) => resolve(ref)?.id).filter((id): id is string => Boolean(id));
        // A speaker is in the shot even if the plan forgot to list them.
        for (const d of dialogue) if (d.asset_id && !assetIds.includes(d.asset_id)) assetIds.push(d.asset_id);
        newShots.push(
          this.createShot(scene.id, {
            kind: s.kind ?? (dialogue.length ? 'dialogue' : 'action'),
            durationS: s.duration_s ?? 5,
            framing: s.framing,
            camera: s.camera,
            prompt: s.prompt,
            dialogue,
            sound: s.sound,
            assetIds,
            audioAssetId: s.audio ? (resolve(s.audio)?.id ?? null) : null,
            recipeId: s.recipe ?? null,
            params: s.params ?? {},
            continues: s.continues ?? false,
          }),
        );
      }
    }
    return { assets: created, scenes: newScenes, shots: newShots };
  }

  // --- Rendering -------------------------------------------------------------

  /**
   * The recipe a shot renders with: its own, or the best installed match
   * for its kind — lip-sync capable for dialogue and talking, a product
   * recipe for product shots, and otherwise any video recipe.
   */
  async recipeFor(shot: ShotRow): Promise<Recipe> {
    if (shot.recipeId) return this.deps.recipes.require(shot.recipeId);
    const project = this.requireProject(shot.projectId);
    const licenceMode = project.licenceMode === 'commercial' ? 'commercial' : this.deps.config.licenceMode;
    const wanted: Record<string, string[]> = {
      dialogue: ['dialogue', 'subject-tags', 'references'],
      talking: ['lip-sync', 'audio-driven', 'dialogue'],
      performance: ['audio-driven', 'lip-sync'],
      product: ['product', 'first-frame'],
      broll: ['first-frame', 'text-to-video'],
      establishing: ['text-to-video', 'first-frame'],
      action: ['first-frame', 'references', 'text-to-video'],
    };
    const candidates: Recipe[] = [];
    for (const recipe of this.deps.recipes.list()) {
      // A shot is written as a prompt; finishing recipes (an upscaler) take a take instead.
      if (recipe.kind !== 'video' || !recipe.params.some((p) => p.name === 'prompt')) continue;
      const status = await this.deps.recipes.status(recipe, this.deps.config.tier, licenceMode);
      if (status.state === 'installed' && !status.licenceBlock) candidates.push(recipe);
    }
    const prefs = wanted[shot.kind] ?? [];
    for (const capability of prefs) {
      const match = candidates.find((r) => r.capabilities.includes(capability));
      if (match) return match;
    }
    if (candidates[0]) return candidates[0];
    throw errors.validation(`No installed video recipe can render a ${shot.kind} shot; install one from Recipes`);
  }

  /** The job request a shot would render as: for previewing a prompt before spending a render on it. */
  async requestFor(shotId: string, mode?: string): Promise<RecipeJobParams & { recipe: string }> {
    const shot = this.requireShot(shotId);
    const project = this.requireProject(shot.projectId);
    const recipe = await this.recipeFor(shot);
    const chosen = mode ?? recipe.default_mode;
    const params = deriveParams({ project, shot, assets: this.listAssets(project.id), recipe, mode: chosen });
    return { recipe: recipe.id, mode: chosen, params, shot_id: shot.id };
  }

  /**
   * Queue `count` takes of each shot. Each take gets its own seed unless the
   * shot fixes one, which is what makes drafting four and finishing the best
   * reproducible: the finish reuses the chosen draft's seed.
   */
  async renderShots(shotIds: string[], options: { mode?: string; count?: number; seed?: number; fromTake?: string }): Promise<TakeRow[]> {
    const created: TakeRow[] = [];
    for (const shotId of shotIds) {
      const request = await this.requestFor(shotId, options.mode);
      const continuing = this.requireShot(shotId);
      if (continuing.continues) request.params = await this.continueFrom(continuing, this.deps.recipes.require(request.recipe), request.params ?? {});
      if (options.fromTake) {
        const take = this.requireTake(options.fromTake);
        if (take.seed !== null) request.params = { ...request.params, seed: take.seed };
      } else if (options.seed !== undefined) {
        request.params = { ...request.params, seed: options.seed };
      }
      const count = options.fromTake ? 1 : (options.count ?? 1);
      const shot = this.requireShot(shotId);
      const recipe = this.deps.recipes.require(request.recipe);
      const chain = this.longTakePlan(shot, recipe, request.mode ?? recipe.default_mode, request.params ?? {}, shot.continues);
      for (let i = 0; i < count; i++) {
        const takeId = newId('tak');
        const prepared = await this.deps.comfy.prepareRequest(chain ? { ...request, params: chain.first } : request, {
          licenceMode: this.requireProject(shot.projectId).licenceMode as LicenceMode,
        });
        const job = this.deps.jobs.create(prepared.recipe.kind, {
          recipe: prepared.recipe.id,
          mode: prepared.mode,
          params: prepared.values,
          shot_id: shotId,
          take_id: takeId,
        });
        const seed = typeof prepared.values.seed === 'number' ? prepared.values.seed : null;
        const row: TakeRow = {
          id: takeId,
          projectId: shot.projectId,
          shotId,
          jobId: job.id,
          mode: prepared.mode,
          seed,
          file: null,
          score: null,
          notes: '',
          review: null,
          // Every segment of a long take renders with the first one's seed.
          chain: chain ? { ...chain.chain, next: { ...chain.chain.next, ...(seed !== null ? { seed } : {}) }, segments: chain.chain.segments.map((s, k) => (k === 0 ? { ...s, jobId: job.id } : { ...s })) } : null,
          master: null,
          createdAt: Date.now(),
        };
        this.db.insert(takes).values(row).run();
        created.push(row);
      }
      this.touch(shot.projectId);
    }
    return created;
  }

  /**
   * A shot that carries on from the one before it: the previous shot's
   * chosen take goes to the recipe's continuation input (H3 pins its last
   * frames, so motion, light and voices run on), and the opening frame is
   * dropped, since the take now opens on that tail. This is how a scene of
   * several directed shots plays as one continuous take, each shot with its
   * own action and lines; the cut trims what the continuation repeats.
   */
  private async continueFrom(shot: ShotRow, recipe: Recipe, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!recipe.continuation) {
      throw errors.validation(`${recipe.name} cannot continue a clip, so shot ${shot.id} cannot carry on from the one before it`);
    }
    const siblings = this.listShots(shot.projectId, shot.sceneId).sort((a, b) => a.position - b.position);
    const previous = siblings[siblings.findIndex((s) => s.id === shot.id) - 1];
    if (!previous) throw errors.validation(`Shot ${shot.id} is the first of its scene, so there is nothing for it to continue`);
    const take = previous.chosenTakeId ? this.db.select().from(takes).where(eq(takes.id, previous.chosenTakeId)).get() : undefined;
    if (!take?.file || kindOf(take.file) !== 'video') {
      throw errors.validation(`Shot ${shot.id} continues the shot before it: choose a finished video take of that shot first`);
    }
    // The take as rendered, not its master: the continuation works at the model's own size.
    const upload = `cont-${take.id}${extname(take.file)}`;
    await copyFile(this.takeFile(take.projectId, take.file), safeResolve(this.deps.paths.uploadsDir, upload));
    const out = { ...params, [recipe.continuation.param]: upload };
    for (const name of ['first_frame', 'image']) delete out[name];
    // The prompt was written for an opening frame the take no longer has.
    if (typeof out.prompt === 'string' && !(shot.params as Record<string, unknown>).prompt) {
      const project = this.requireProject(shot.projectId);
      out.prompt = composePrompt({ project, shot, assets: this.listAssets(project.id), recipe, continuing: true });
    }
    return out;
  }

  /** Seconds a continuing shot's take repeats of the shot before it, which the cut trims. */
  private continuedOverlap(shot: ShotRow, take: TakeRow): number {
    if (!shot.continues) return 0;
    const job = this.deps.jobs.get(take.jobId);
    const id = (job?.params as RecipeJobParams | undefined)?.recipe ?? shot.recipeId;
    try {
      return id ? (this.deps.recipes.require(id).continuation?.overlap_s ?? 0) : 0;
    } catch {
      return 0;
    }
  }

  /** A recipe's length input, and the continuation it chains with, if it has both. */
  private chainable(recipe: Recipe): { duration: RecipeParam & { max: number }; param: string; overlapS: number } | null {
    const duration = recipe.params.find((p) => (p.name === 'duration' || p.name === 'seconds') && (p.type === 'float' || p.type === 'int'));
    if (!recipe.continuation || !duration || duration.max === undefined) return null;
    return { duration: duration as RecipeParam & { max: number }, param: recipe.continuation.param, overlapS: recipe.continuation.overlap_s };
  }

  /**
   * When a shot is longer than its recipe renders at once, the first
   * segment's parameters and the chain that renders the rest.
   */
  private longTakePlan(
    shot: ShotRow,
    recipe: Recipe,
    mode: string,
    params: Record<string, unknown>,
    continuing = false,
  ): { first: Record<string, unknown>; chain: TakeChain } | null {
    const spec = this.chainable(recipe);
    // A length pinned in the shot's own parameters is taken as asked.
    if (!spec || (shot.params as Record<string, unknown>)[spec.duration.name] !== undefined) return null;
    if (shot.durationS <= spec.duration.max + 0.05) return null;
    let durations: number[];
    try {
      // A shot that continues the one before it repeats that shot's tail in its first segment too.
      durations = planSegments(shot.durationS, { max: spec.duration.max, min: spec.duration.min, overlap: spec.overlapS, continuing });
    } catch (err) {
      throw errors.validation(`Shot ${shot.id}: ${(err as Error).message}; shorten it or split it into shots`);
    }
    const first = { ...params, [spec.duration.name]: durations[0] };
    delete first.last_frame;
    return {
      first,
      chain: {
        kind: 'long',
        param: spec.param,
        durationParam: spec.duration.name,
        overlapS: spec.overlapS,
        total: shot.durationS,
        ...this.continuationParams(shot, recipe, mode, params),
        segments: durations.map((duration) => ({ duration })),
        index: 0,
        state: 'rendering',
      },
    };
  }

  /**
   * What a continuing segment renders with. The shot's opening (first
   * frame, dialogue, driving audio) belongs to the first segment only; the
   * ones after it continue the picture with the shot's prompt alone, and the
   * last ends on the shot's last frame.
   */
  private continuationParams(
    shot: ShotRow,
    recipe: Recipe,
    mode: string,
    params: Record<string, unknown>,
  ): { next: Record<string, unknown>; last: Record<string, unknown> } {
    const project = this.requireProject(shot.projectId);
    const next = deriveParams({
      project,
      shot: { ...shot, dialogue: [], keyframes: {}, audioAssetId: null },
      assets: this.listAssets(project.id),
      recipe,
      mode,
      continuing: true,
    });
    for (const name of ['first_frame', 'image', 'audio', 'last_frame']) delete next[name];
    return { next, last: params.last_frame !== undefined ? { last_frame: params.last_frame } : {} };
  }

  /**
   * Re-render a take from `from` seconds on, keeping what comes before: the
   * kept opening is cut out of the original, and a chain continues it for
   * the rest of the take's length. The original take is left as it was, so
   * the two can be compared and either chosen.
   */
  async retake(takeId: string, options: { from: number; mode?: string; seed?: number }): Promise<TakeRow> {
    const source = this.requireTake(takeId);
    if (!source.file) throw errors.validation(`Take ${takeId} has no finished file to retake`);
    const shot = this.requireShot(source.shotId);
    const job = this.deps.jobs.get(source.jobId);
    const recipeId = (job?.params as unknown as RecipeJobParams | undefined)?.recipe ?? (await this.recipeFor(shot)).id;
    const recipe = this.deps.recipes.require(recipeId);
    const spec = this.chainable(recipe);
    if (!spec) throw errors.validation(`${recipe.name} cannot continue a clip, so it cannot retake part of one`);
    const path = this.takeFile(source.projectId, source.file);
    const info = await probeMedia(path);
    const from = options.from;
    if (!(from >= spec.overlapS && from < info.duration - 0.5)) {
      throw errors.validation(`Retake from between ${spec.overlapS.toFixed(1)} s and ${(info.duration - 0.5).toFixed(1)} s of this ${info.duration.toFixed(1)} s take`);
    }
    let durations: number[];
    try {
      durations = planSegments(info.duration - from, { max: spec.duration.max, min: spec.duration.min, overlap: spec.overlapS, continuing: true });
    } catch (err) {
      throw errors.validation((err as Error).message);
    }

    // The kept opening, as an upload the first segment continues. It is
    // re-encoded so its last frames are exactly at `from`.
    const newTakeId = newId('tak');
    const head = `chain-${newTakeId}-head.mp4`;
    await runFfmpeg(
      ['-i', path, '-t', from.toFixed(3), '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', ...(info.hasAudio ? ['-c:a', 'aac'] : ['-an']), safeResolve(this.deps.paths.uploadsDir, head)],
      300_000,
    );

    const mode = options.mode ?? source.mode;
    const request = await this.requestFor(shot.id, mode);
    const { next, last } = this.continuationParams(shot, recipe, mode, request.params ?? {});
    delete next[spec.duration.name];
    const seed = options.seed ?? source.seed;
    if (seed !== null && seed !== undefined) next.seed = seed;
    const chain: TakeChain = {
      kind: 'retake',
      param: spec.param,
      durationParam: spec.duration.name,
      overlapS: spec.overlapS,
      total: info.duration,
      next,
      last,
      head,
      from,
      sourceTakeId: source.id,
      segments: durations.map((duration) => ({ duration })),
      index: 0,
      state: 'rendering',
    };
    const row: TakeRow = {
      id: newTakeId,
      projectId: source.projectId,
      shotId: source.shotId,
      jobId: '',
      mode,
      seed: typeof next.seed === 'number' ? next.seed : null,
      file: null,
      score: null,
      notes: `Retake of ${source.id} from ${from.toFixed(1)} s`,
      review: null,
      chain,
      master: null,
      createdAt: Date.now(),
    };
    this.db.insert(takes).values(row).run();
    try {
      await this.startSegment(row, recipe.id);
    } catch (err) {
      this.db.delete(takes).where(eq(takes.id, row.id)).run();
      await rm(safeResolve(this.deps.paths.uploadsDir, head), { force: true });
      throw err;
    }
    this.touch(source.projectId);
    return this.requireTake(row.id);
  }

  /** Queue the chain's current segment, continuing the one before it (or a retake's head). */
  private async startSegment(take: TakeRow, recipeId: string): Promise<void> {
    const chain = take.chain as TakeChain;
    const k = chain.index;
    const previous = k === 0 ? chain.head : chain.segments[k - 1].upload;
    if (!previous) throw errors.validation(`Segment ${k + 1} of take ${take.id} has nothing to continue`);
    const params = {
      ...chain.next,
      ...(k === chain.segments.length - 1 ? chain.last : {}),
      [chain.param]: previous,
      [chain.durationParam]: chain.segments[k].duration,
    };
    const prepared = await this.deps.comfy.prepareRequest(
      { recipe: recipeId, mode: take.mode, params, shot_id: take.shotId },
      { licenceMode: this.requireProject(take.projectId).licenceMode as LicenceMode },
    );
    const job = this.deps.jobs.create(prepared.recipe.kind, {
      recipe: prepared.recipe.id,
      mode: prepared.mode,
      params: prepared.values,
      shot_id: take.shotId,
      take_id: take.id,
      segment: k,
    });
    const segments = chain.segments.map((s, i) => (i === k ? { ...s, jobId: job.id } : s));
    this.db.update(takes).set({ jobId: job.id, chain: { ...chain, segments } }).where(eq(takes.id, take.id)).run();
  }

  private setChain(takeId: string, chain: TakeChain): void {
    this.db.update(takes).set({ chain }).where(eq(takes.id, takeId)).run();
  }

  /**
   * A chain segment settled: keep its output for the next segment to
   * continue, then queue that one, or join them all into the take.
   */
  private async advanceChain(take: TakeRow, job: Job, path: string | undefined): Promise<void> {
    const chain = take.chain as TakeChain;
    const k = (job.params as { segment?: number }).segment ?? 0;
    if (chain.state !== 'rendering' || k !== chain.index) return;
    if (job.status !== 'completed' || !path) {
      this.setChain(take.id, { ...chain, state: 'failed', error: `Segment ${k + 1} of ${chain.segments.length} ${job.status}` });
      return;
    }
    try {
      const upload = `chain-${take.id}-${k}${extname(path)}`;
      await copyFile(path, safeResolve(this.deps.paths.uploadsDir, upload));
      const segments = chain.segments.map((s, i) => (i === k ? { ...s, upload } : s));
      if (k + 1 < segments.length) {
        const next = { ...chain, segments, index: k + 1 };
        this.setChain(take.id, next);
        await this.startSegment({ ...take, chain: next }, (job.params as unknown as RecipeJobParams).recipe);
        return;
      }
      this.setChain(take.id, { ...chain, segments, state: 'joining' });
      const parts: JoinPart[] = [];
      if (chain.head) parts.push({ path: safeResolve(this.deps.paths.uploadsDir, chain.head) });
      segments.forEach((s, i) => {
        parts.push({ path: safeResolve(this.deps.paths.uploadsDir, s.upload as string), start: i > 0 || chain.head ? chain.overlapS : undefined });
      });
      const infos = await Promise.all(parts.map((p) => probeMedia(p.path)));
      const name = `${take.id}.mp4`;
      await mkdir(join(safeResolve(this.deps.paths.projectsDir, take.projectId), 'files'), { recursive: true });
      await runFfmpeg(
        joinArgs(parts, {
          audio: infos.every((i) => i.hasAudio),
          total: chain.total,
          fps: this.requireProject(take.projectId).fps,
          output: this.takeFile(take.projectId, name),
        }),
        600_000,
      );
      this.db.update(takes).set({ file: name, chain: { ...chain, segments, state: 'done' } }).where(eq(takes.id, take.id)).run();
    } catch (err) {
      const message = (err as Error).message;
      this.deps.log.warn({ take: take.id, err: message }, 'long take could not continue');
      this.setChain(take.id, { ...chain, state: 'failed', error: message });
    }
  }

  requireTake(id: string): TakeRow {
    const row = this.db.select().from(takes).where(eq(takes.id, id)).get();
    if (!row) throw proErrors.takeNotFound(id);
    return row;
  }

  listTakes(shotId: string): TakeView[] {
    return this.db
      .select()
      .from(takes)
      .where(eq(takes.shotId, shotId))
      .orderBy(desc(takes.createdAt))
      .all()
      .map((take) => this.viewTake(take));
  }

  viewTake(take: TakeRow): TakeView {
    const job = take.jobId ? this.deps.jobs.get(take.jobId) : null;
    const chain = take.chain as TakeChain | null;
    if (chain && chain.state !== 'done') {
      // A chain is one take to the user: running until the last segment is
      // joined, with progress across all of its segments.
      const n = chain.segments.length;
      const settled = job && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled');
      return {
        ...take,
        chain,
        master: null,
        status: chain.state === 'failed' ? (job?.status === 'cancelled' ? 'cancelled' : 'failed') : job && !settled ? job.status : 'running',
        progress: chain.state === 'joining' ? 0.99 : (chain.index + (settled ? 1 : (job?.progress ?? 0))) / n,
        error: chain.state === 'failed' ? (job?.error ?? { code: 'GENERATION_FAILED', message: chain.error ?? 'The long take failed' }) : undefined,
        kind: 'video',
      };
    }
    const result = chain ? {} : ((job?.result ?? {}) as Record<string, unknown>);
    const kind = result.video_url ? 'video' : result.image_url ? 'image' : result.audio_url ? 'audio' : undefined;
    return {
      ...take,
      chain,
      master: this.viewMaster(take),
      status: chain ? 'completed' : (job?.status ?? (take.file ? 'completed' : 'missing')),
      progress: chain ? 1 : (job?.progress ?? (take.file ? 1 : 0)),
      error: chain ? undefined : job?.error,
      kind: kind ?? (take.file ? kindOf(take.file) : undefined),
      url: take.file
        ? `/v1/projects/${encodeURIComponent(take.projectId)}/files/${encodeURIComponent(take.file)}`
        : ((result.video_url ?? result.image_url ?? result.audio_url) as string | undefined),
    };
  }

  /** Store a vision model's check of a take (see engines/analyze.ts). */
  setTakeReview(id: string, review: TakeReview): TakeView {
    this.requireTake(id);
    this.db.update(takes).set({ review }).where(eq(takes.id, id)).run();
    return this.viewTake(this.requireTake(id));
  }

  updateTake(id: string, input: { score?: number | null; notes?: string }): TakeView {
    this.requireTake(id);
    this.db.update(takes).set(input).where(eq(takes.id, id)).run();
    return this.viewTake(this.requireTake(id));
  }

  chooseTake(id: string): ShotRow {
    const take = this.requireTake(id);
    // A take still rendering can be chosen (it is what the cut will use once
    // it lands); one that failed or was cancelled never will be.
    const { status } = this.viewTake(take);
    if (status === 'failed' || status === 'cancelled' || status === 'missing') {
      throw errors.validation(`Take ${id} ${status === 'missing' ? 'has no file' : status}; choose another`);
    }
    this.db.update(shots).set({ chosenTakeId: id, updatedAt: Date.now() }).where(eq(shots.id, take.shotId)).run();
    this.touch(take.projectId);
    return this.requireShot(take.shotId);
  }

  async deleteTake(id: string): Promise<void> {
    const take = this.requireTake(id);
    const job = this.deps.jobs.get(take.jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) this.deps.jobs.cancel(job.id);
    if (take.file) await rm(this.takeFile(take.projectId, take.file), { force: true });
    const master = take.master as TakeMaster | null;
    if (master?.file) await rm(this.takeFile(take.projectId, master.file), { force: true });
    const chain = take.chain as TakeChain | null;
    for (const upload of [chain?.head, ...(chain?.segments ?? []).map((s) => s.upload)]) {
      if (upload) await rm(safeResolve(this.deps.paths.uploadsDir, upload), { force: true });
    }
    this.db.delete(takes).where(eq(takes.id, id)).run();
    this.db.update(shots).set({ chosenTakeId: null }).where(eq(shots.chosenTakeId, id)).run();
  }

  /** Where a project keeps a file (takes, cut exports). */
  takeFile(projectId: string, name: string): string {
    return safeResolve(join(safeResolve(this.deps.paths.projectsDir, projectId), 'files'), name);
  }

  /** Copy a finished take's output into the project, so retention cannot sweep it. */
  private async onJobSettled(job: Job): Promise<void> {
    const params = job.params as unknown as RecipeJobParams;
    if (!params.take_id) return;
    const take = this.db.select().from(takes).where(eq(takes.id, params.take_id)).get();
    if (!take) return;
    const result = (job.result ?? {}) as Record<string, unknown>;
    const path = (result.video_path ?? result.image_path ?? result.audio_path) as string | undefined;
    if ((job.params as { master?: boolean }).master) return this.settleMaster(take, job, path);
    if (take.chain) return this.advanceChain(take, job, path);
    if (!path || job.status !== 'completed') return;
    try {
      const name = `${take.id}${extname(path)}`;
      const target = this.takeFile(take.projectId, name);
      await mkdir(join(safeResolve(this.deps.paths.projectsDir, take.projectId), 'files'), { recursive: true });
      await copyFile(path, target);
      this.db.update(takes).set({ file: name }).where(eq(takes.id, take.id)).run();
    } catch (err) {
      this.deps.log.warn({ take: take.id, err: (err as Error).message }, 'could not keep a take in its project');
    }
  }

  // --- Mastering -------------------------------------------------------------

  /**
   * Master a finished video take for delivery: upscale it with a finishing
   * recipe (SeedVR2 by default) and keep its own soundtrack. Drafting at
   * the card's comfortable size and mastering only what makes the cut is
   * how a 16 GB box delivers 1080p: the cut otherwise stretches a 0.5 MP
   * render with ffmpeg. The take's file is untouched; the cut uses the
   * master once it is done.
   */
  async masterTake(takeId: string, options: { recipe?: string; scale?: number } = {}): Promise<TakeView> {
    const take = this.requireTake(takeId);
    if (!take.file || kindOf(take.file) !== 'video') throw errors.validation(`Take ${takeId} has no finished video to master`);
    const current = take.master as TakeMaster | null;
    if (current?.state === 'rendering') {
      const job = this.deps.jobs.get(current.jobId);
      if (job && (job.status === 'queued' || job.status === 'running')) return this.viewTake(take);
    }
    const recipe = await this.masterRecipe(options.recipe);
    const scale = recipe.params.find((p) => p.name === 'scale');
    // The recipe reads its input from uploads, like any other.
    const upload = `master-src-${take.id}${extname(take.file)}`;
    await copyFile(this.takeFile(take.projectId, take.file), safeResolve(this.deps.paths.uploadsDir, upload));
    const prepared = await this.deps.comfy.prepareRequest(
      {
        recipe: recipe.id,
        params: { video: upload, ...(scale && options.scale !== undefined ? { scale: options.scale } : {}) },
        shot_id: take.shotId,
      },
      { licenceMode: this.requireProject(take.projectId).licenceMode as LicenceMode },
    );
    const job = this.deps.jobs.create(prepared.recipe.kind, {
      recipe: prepared.recipe.id,
      mode: prepared.mode,
      params: prepared.values,
      shot_id: take.shotId,
      take_id: take.id,
      master: true,
    });
    if (current?.file) await rm(this.takeFile(take.projectId, current.file), { force: true });
    const master: TakeMaster = { jobId: job.id, recipe: recipe.id, state: 'rendering' };
    this.db.update(takes).set({ master }).where(eq(takes.id, take.id)).run();
    this.touch(take.projectId);
    return this.viewTake(this.requireTake(take.id));
  }

  /** Master each shot's chosen take. Shots with no finished chosen take are skipped, and listed. */
  async masterChosen(shotIds: string[], options: { recipe?: string; scale?: number } = {}): Promise<{ takes: TakeView[]; skipped: string[] }> {
    const out: TakeView[] = [];
    const skipped: string[] = [];
    for (const shotId of shotIds) {
      const shot = this.requireShot(shotId);
      const take = shot.chosenTakeId ? this.db.select().from(takes).where(eq(takes.id, shot.chosenTakeId)).get() : undefined;
      if (!take?.file) {
        skipped.push(shotId);
        continue;
      }
      out.push(await this.masterTake(take.id, options));
    }
    return { takes: out, skipped };
  }

  /** The finishing recipe a master uses: the one asked for, else the first installed video upscaler. */
  private async masterRecipe(id?: string): Promise<Recipe> {
    if (id) return this.deps.recipes.require(id);
    for (const recipe of this.deps.recipes.list()) {
      if (recipe.kind !== 'video' || !recipe.capabilities.includes('upscale') || !recipe.params.some((p) => p.name === 'video')) continue;
      const status = await this.deps.recipes.status(recipe, this.deps.config.tier, this.deps.config.licenceMode);
      if (status.state === 'installed') return recipe;
    }
    throw errors.validation('No video upscaler is installed to master with; install SeedVR2 (seedvr2-upscale-video) from Recipes');
  }

  /**
   * A master job settled: keep its output in the project with the take's
   * soundtrack laid back under it, since an upscaler returns pictures only.
   */
  private async settleMaster(take: TakeRow, job: Job, path: string | undefined): Promise<void> {
    const master = take.master as TakeMaster | null;
    if (!master || master.jobId !== job.id) return;
    const source = safeResolve(this.deps.paths.uploadsDir, `master-src-${take.id}${extname(take.file ?? '.mp4')}`);
    try {
      if (job.status !== 'completed' || !path) {
        this.db.update(takes).set({ master: { ...master, state: 'failed', error: job.error?.message ?? `The master ${job.status}` } }).where(eq(takes.id, take.id)).run();
        return;
      }
      const name = `${take.id}-master.mp4`;
      const target = this.takeFile(take.projectId, name);
      const [upscaled, original] = await Promise.all([probeMedia(path), take.file ? probeMedia(this.takeFile(take.projectId, take.file)) : null]);
      if (original?.hasAudio && !upscaled.hasAudio && take.file) {
        await runFfmpeg(
          ['-i', path, '-i', this.takeFile(take.projectId, take.file), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', target],
          300_000,
        );
      } else {
        await copyFile(path, target);
      }
      this.db.update(takes).set({ master: { ...master, state: 'done', file: name } }).where(eq(takes.id, take.id)).run();
    } catch (err) {
      const message = (err as Error).message;
      this.deps.log.warn({ take: take.id, err: message }, 'could not keep a master');
      this.db.update(takes).set({ master: { ...master, state: 'failed', error: message } }).where(eq(takes.id, take.id)).run();
    } finally {
      await rm(source, { force: true });
    }
  }

  private viewMaster(take: TakeRow): TakeView['master'] {
    const master = take.master as TakeMaster | null;
    if (!master) return null;
    const job = this.deps.jobs.get(master.jobId);
    return {
      ...master,
      status: master.state === 'done' ? 'completed' : master.state === 'failed' ? 'failed' : job?.status,
      progress: master.state === 'done' ? 1 : (job?.progress ?? 0),
      url: master.file ? `/v1/projects/${encodeURIComponent(take.projectId)}/files/${encodeURIComponent(master.file)}` : undefined,
    };
  }

  /** The file a cut plays for a take: its master once done, else the take as rendered. */
  deliveryFile(take: TakeRow): string | null {
    const master = take.master as TakeMaster | null;
    return master?.state === 'done' && master.file ? master.file : take.file;
  }

  // --- Cuts ------------------------------------------------------------------

  listCuts(projectId: string): CutRow[] {
    return this.db.select().from(cuts).where(eq(cuts.projectId, projectId)).orderBy(asc(cuts.createdAt)).all();
  }

  requireCut(id: string): CutRow {
    const row = this.db.select().from(cuts).where(eq(cuts.id, id)).get();
    if (!row) throw errors.validation(`Cut not found: ${id}`);
    return row;
  }

  /** A cut of every shot's chosen take, in story order: the first draft of an edit. */
  createCut(projectId: string, input: CutInput = {}): CutRow {
    this.requireProject(projectId);
    const items =
      input.items ??
      this.listShots(projectId)
        .sort((a, b) => this.sceneOrder(a) - this.sceneOrder(b) || a.position - b.position)
        .filter((s) => s.chosenTakeId)
        .map((s) => {
          const take = this.db.select().from(takes).where(eq(takes.id, s.chosenTakeId as string)).get();
          const overlap = take ? this.continuedOverlap(s, take) : 0;
          // A continuing shot opens on the frames it repeats of the shot before; the cut starts after them.
          return { take_id: s.chosenTakeId as string, ...(overlap > 0 ? { in: Math.round(overlap * 1000) / 1000 } : {}) };
        });
    const now = Date.now();
    const row: CutRow = {
      id: newId('cut'),
      projectId,
      name: input.name ?? 'Main cut',
      items,
      music: input.music ?? null,
      subtitles: input.subtitles ?? false,
      beatSync: input.beatSync ?? false,
      exportJobId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(cuts).values(row).run();
    this.touch(projectId);
    return row;
  }

  private sceneOrder(shot: ShotRow): number {
    return this.requireScene(shot.sceneId).position;
  }

  updateCut(id: string, input: CutInput): CutRow {
    this.requireCut(id);
    this.db.update(cuts).set({ ...input, updatedAt: Date.now() }).where(eq(cuts.id, id)).run();
    return this.requireCut(id);
  }

  deleteCut(id: string): void {
    this.requireCut(id);
    this.db.delete(cuts).where(eq(cuts.id, id)).run();
  }

  /** Queue the cut's render; the render engine assembles it with ffmpeg. */
  exportCut(id: string): Job {
    const cut = this.requireCut(id);
    if ((cut.items as unknown[]).length === 0) throw errors.validation('This cut has no takes in it yet');
    const job = this.deps.jobs.create('render', { cut_id: id });
    this.db.update(cuts).set({ exportJobId: job.id, updatedAt: Date.now() }).where(eq(cuts.id, id)).run();
    return job;
  }

  // --- The whole project -----------------------------------------------------

  /** Everything the storyboard and Claude need, in one read. */
  getProject(id: string) {
    const project = this.requireProject(id);
    const allShots = this.listShots(id);
    return {
      ...project,
      assets: this.listAssets(id),
      scenes: this.listScenes(id).map((scene) => ({
        ...scene,
        shots: allShots
          .filter((shot) => shot.sceneId === scene.id)
          .map((shot) => ({ ...shot, takes: this.listTakes(shot.id) })),
      })),
      cuts: this.listCuts(id).map((cut) => {
        const job = cut.exportJobId ? this.deps.jobs.get(cut.exportJobId) : null;
        return { ...cut, export: job ? { status: job.status, progress: job.progress, error: job.error, result: job.result } : null };
      }),
    };
  }
}

function kindOf(name: string): 'image' | 'video' | 'audio' {
  const ext = extname(name).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) return 'video';
  if (['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(ext)) return 'audio';
  return 'image';
}
