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
import type { Recipe } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import { deriveParams } from './derive.js';
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
  >
>;
export type CutInput = Partial<Pick<CutRow, 'name' | 'items' | 'music' | 'subtitles'>>;

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
      dialogue?: { speaker: string; line: string }[];
      sound?: string;
      /** Asset refs or ids. */
      assets?: string[];
      audio?: string;
      recipe?: string;
      params?: Record<string, unknown>;
    }[];
  }[];
}

export interface TakeView extends TakeRow {
  status: Job['status'] | 'missing';
  progress: number;
  error?: Job['error'];
  url?: string;
  kind?: 'image' | 'video' | 'audio';
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {
    deps.jobs.on('completed', (job: Job) => void this.onJobSettled(job));
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
        const dialogue = (s.dialogue ?? []).map((d) => {
          const asset = resolve(d.speaker);
          return asset ? { asset_id: asset.id, line: d.line } : { speaker: d.speaker, line: d.line };
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
      if (options.fromTake) {
        const take = this.requireTake(options.fromTake);
        if (take.seed !== null) request.params = { ...request.params, seed: take.seed };
      } else if (options.seed !== undefined) {
        request.params = { ...request.params, seed: options.seed };
      }
      const count = options.fromTake ? 1 : (options.count ?? 1);
      for (let i = 0; i < count; i++) {
        const takeId = newId('tak');
        const prepared = await this.deps.comfy.prepareRequest(request, {
          licenceMode: this.requireProject(this.requireShot(shotId).projectId).licenceMode as LicenceMode,
        });
        const job = this.deps.jobs.create(prepared.recipe.kind, {
          recipe: prepared.recipe.id,
          mode: prepared.mode,
          params: prepared.values,
          shot_id: shotId,
          take_id: takeId,
        });
        const shot = this.requireShot(shotId);
        const row: TakeRow = {
          id: takeId,
          projectId: shot.projectId,
          shotId,
          jobId: job.id,
          mode: prepared.mode,
          seed: typeof prepared.values.seed === 'number' ? prepared.values.seed : null,
          file: null,
          score: null,
          notes: '',
          createdAt: Date.now(),
        };
        this.db.insert(takes).values(row).run();
        created.push(row);
      }
      this.touch(this.requireShot(shotId).projectId);
    }
    return created;
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
    const job = this.deps.jobs.get(take.jobId);
    const result = (job?.result ?? {}) as Record<string, unknown>;
    const kind = result.video_url ? 'video' : result.image_url ? 'image' : result.audio_url ? 'audio' : undefined;
    return {
      ...take,
      status: job?.status ?? (take.file ? 'completed' : 'missing'),
      progress: job?.progress ?? (take.file ? 1 : 0),
      error: job?.error,
      kind: kind ?? (take.file ? kindOf(take.file) : undefined),
      url: take.file
        ? `/v1/projects/${encodeURIComponent(take.projectId)}/files/${encodeURIComponent(take.file)}`
        : ((result.video_url ?? result.image_url ?? result.audio_url) as string | undefined),
    };
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
    if (!path) return;
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
        .map((s) => ({ take_id: s.chosenTakeId as string }));
    const now = Date.now();
    const row: CutRow = {
      id: newId('cut'),
      projectId,
      name: input.name ?? 'Main cut',
      items,
      music: input.music ?? null,
      subtitles: input.subtitles ?? false,
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
