import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@pepper/core/db/client.js';
import type { DownloadManager, DownloadTask } from '@pepper/core/downloads/manager.js';
import { errors } from '@pepper/core/errors.js';
import { safeResolve } from '@pepper/core/paths.js';
import type { StorageMonitor } from '@pepper/core/services/storage.js';
import type { LoraPatch } from '../comfy/graph.js';
import type { ProConfig } from '../config.js';
import { proErrors } from '../errors.js';
import type { ProPaths } from '../paths.js';
import type { DownloadKind, DownloadSlot } from '../recipes/layout.js';
import type { Recipe, WorkflowSpec } from '../recipes/schema.js';
import type { RecipeStore } from '../recipes/store.js';
import { LORA_BASE_IDS, baseLabel, type LoraBaseId } from './bases.js';
import { loras, type LoraRow } from './schema.js';
import { lookupLora, type LoraCandidate } from './sources.js';

/** The download bundle, and the prefix ComfyUI's `lora_name` sees. */
export const LIBRARY_BUNDLE = 'loras/library';
const LIBRARY_PREFIX = 'library/';

export type LoraState = 'installed' | 'queued' | 'downloading' | 'failed' | 'missing';

export interface LoraView {
  id: string;
  name: string;
  base: string;
  base_label: string;
  file: string;
  url: string;
  source: string;
  page_url: string | null;
  source_base: string | null;
  trigger_words: string[];
  strength: number;
  description: string;
  preview_url: string | null;
  bytes: number | null;
  sha256: string | null;
  created_at: number;
  updated_at: number;
  state: LoraState;
  /** The latest download, while it runs or when it failed. */
  download?: { id: string; received: number; total: number | null; error?: string };
  /** Installed recipes this LoRA can run with. */
  recipes: string[];
}

export interface AddLoraInput {
  url: string;
  /** Which file, for a repository or Civitai version with several. */
  file?: string;
  name?: string;
  base?: string;
  trigger_words?: string[];
  strength?: number;
  description?: string;
}

export type LoraPatchInput = Partial<Pick<LoraRow, 'name' | 'base' | 'triggerWords' | 'strength' | 'description'>>;

/** A LoRA a request asks for: by id, at a strength or the LoRA's own. */
export interface LoraRequest {
  id: string;
  strength?: number;
}

/** What a job ran with, for its metadata: names are what a person recognises later. */
export interface UsedLora {
  id: string;
  name: string;
  strength: number;
}

export interface LoraServiceDeps {
  db: Db;
  downloads: DownloadManager<DownloadKind, DownloadSlot>;
  storage: StorageMonitor;
  recipes: RecipeStore;
  paths: ProPaths;
  config: ProConfig;
  log: FastifyBaseLogger;
  /** For tests: what looks a link up. */
  lookup?: typeof lookupLora;
}

/** A readable id from a name, cut at a word: what a request (or Claude) names the LoRA by. */
function slug(text: string): string {
  const full = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = full.length > 40 ? full.slice(0, 41).replace(/-[^-]*$/, '') : full;
  return cut || 'lora';
}

export class LoraService {
  readonly dir: string;

  constructor(private readonly deps: LoraServiceDeps) {
    this.dir = join(deps.paths.modelsDir, 'loras', 'library');
  }

  private rows(): LoraRow[] {
    return this.deps.db.select().from(loras).all();
  }

  private row(id: string): LoraRow {
    const row = this.deps.db.select().from(loras).where(eq(loras.id, id)).get();
    if (!row) throw proErrors.loraNotFound(id);
    return row;
  }

  /** The newest download of each library file. */
  private latestDownloads(): Map<string, DownloadTask<DownloadKind, DownloadSlot>> {
    const latest = new Map<string, DownloadTask<DownloadKind, DownloadSlot>>();
    for (const task of this.deps.downloads.list({ kind: 'comfy', bundle: LIBRARY_BUNDLE })) {
      const seen = latest.get(task.name);
      if (!seen || task.createdAt > seen.createdAt) latest.set(task.name, task);
    }
    return latest;
  }

  private async onDisk(file: string): Promise<boolean> {
    return stat(safeResolve(this.dir, file)).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  /** Installed recipes by base: what each LoRA can be used with. */
  private async recipesByBase(): Promise<Map<string, string[]>> {
    const byBase = new Map<string, string[]>();
    for (const recipe of this.deps.recipes.list()) {
      if (!recipe.lora_base) continue;
      const status = await this.deps.recipes.status(recipe, this.deps.config.tier, this.deps.config.licenceMode);
      if (status.state !== 'installed') continue;
      byBase.set(recipe.lora_base, [...(byBase.get(recipe.lora_base) ?? []), recipe.id]);
    }
    return byBase;
  }

  private async view(
    row: LoraRow,
    downloads = this.latestDownloads(),
    byBase?: Map<string, string[]>,
  ): Promise<LoraView> {
    const task = downloads.get(row.file);
    const active = task && (task.status === 'queued' || task.status === 'downloading');
    const present = !active && (await this.onDisk(row.file));
    const state: LoraState = present
      ? 'installed'
      : active
        ? (task.status as 'queued' | 'downloading')
        : task && (task.status === 'failed' || task.status === 'cancelled')
          ? 'failed'
          : 'missing';
    return {
      id: row.id,
      name: row.name,
      base: row.base,
      base_label: baseLabel(row.base),
      file: row.file,
      url: row.url,
      source: row.source,
      page_url: row.pageUrl,
      source_base: row.sourceBase,
      trigger_words: row.triggerWords,
      strength: row.strength,
      description: row.description,
      preview_url: row.previewUrl,
      bytes: row.bytes,
      sha256: row.sha256,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      state,
      download:
        task && state !== 'installed' && state !== 'missing'
          ? { id: task.id, received: task.received, total: task.total, error: task.error }
          : undefined,
      recipes: (byBase ?? (await this.recipesByBase())).get(row.base) ?? [],
    };
  }

  async list(): Promise<LoraView[]> {
    const downloads = this.latestDownloads();
    const byBase = await this.recipesByBase();
    const rows = this.rows().sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(rows.map((row) => this.view(row, downloads, byBase)));
  }

  /** The base a LoRA is for; a 400, not a 404, since it names an input of a request. */
  baseOf(id: string): string {
    const row = this.deps.db.select().from(loras).where(eq(loras.id, id)).get();
    if (!row) throw errors.validation(`No LoRA "${id}" in the library`);
    return row.base;
  }

  /** One LoRA's row, or undefined: for callers that skip a missing LoRA rather than fail. */
  find(id: string): { id: string; name: string; base: string } | undefined {
    return this.deps.db.select().from(loras).where(eq(loras.id, id)).get();
  }

  /**
   * Of these LoRAs, the ones made for `base`, each at its given or default
   * strength, and their trigger words. A cast member may carry a LoRA for
   * each model it is rendered with, and one deleted from the library since
   * leaves no gap: both are simply left out.
   */
  fitting(requested: LoraRequest[], base: string): { loras: { id: string; strength: number }[]; words: string[] } {
    const out: { id: string; strength: number }[] = [];
    const words: string[] = [];
    for (const request of requested) {
      const row = this.deps.db.select().from(loras).where(eq(loras.id, request.id)).get();
      if (!row || row.base !== base || out.some((l) => l.id === row.id)) continue;
      out.push({ id: row.id, strength: request.strength ?? row.strength });
      words.push(...row.triggerWords);
    }
    return { loras: out, words: [...new Set(words)] };
  }

  async get(id: string): Promise<LoraView> {
    return this.view(this.row(id));
  }

  /** What a link would add, without adding it: for the add dialog to show and correct. */
  async lookup(url: string, file?: string): Promise<LoraCandidate & { existing?: string }> {
    const candidate = await (this.deps.lookup ?? lookupLora)(url, {
      file,
      hfToken: this.deps.config.hfToken,
      civitaiToken: this.deps.config.civitaiToken,
    });
    const existing = this.rows().find(
      (row) => row.url === candidate.url || (candidate.sha256 && row.sha256 === candidate.sha256),
    );
    return { ...candidate, existing: existing?.id };
  }

  async add(input: AddLoraInput): Promise<LoraView> {
    const candidate = await this.lookup(input.url, input.file);
    if (candidate.existing) throw errors.validation(`That LoRA is already in the library as "${candidate.existing}"`);
    const base = input.base ?? candidate.base;
    if (!base) {
      throw errors.validation(
        `Could not tell which model this LoRA is for${candidate.source_base ? ` (the source says "${candidate.source_base}")` : ''}; ` +
          `give base: one of ${LORA_BASE_IDS.join(', ')}`,
      );
    }
    this.assertBase(base);

    const rows = this.rows();
    const ids = new Set(rows.map((row) => row.id));
    const root = slug(input.name ?? candidate.name);
    let id = root;
    for (let n = 2; ids.has(id); n++) id = `${root}-${n}`;
    // Two LoRAs may both be called `lora.safetensors`; each keeps its own file.
    const files = new Set(rows.map((row) => row.file));
    let file = candidate.file;
    for (let n = 2; files.has(file) || (await this.onDisk(file)); n++) file = candidate.file.replace(/\.safetensors$/i, `-${n}.safetensors`);

    if (candidate.bytes) {
      await this.deps.storage.assertRoom(candidate.bytes, this.deps.downloads.pendingBytes(), `the LoRA "${candidate.name}"`);
    }
    const now = Date.now();
    const row: LoraRow = {
      id,
      name: input.name?.trim() || candidate.name,
      base,
      file,
      url: candidate.url,
      source: candidate.source,
      pageUrl: candidate.page_url ?? null,
      sourceBase: candidate.source_base ?? null,
      triggerWords: input.trigger_words ?? candidate.trigger_words,
      strength: input.strength ?? 1,
      description: input.description ?? candidate.description ?? '',
      previewUrl: candidate.preview_url ?? null,
      bytes: candidate.bytes ?? null,
      sha256: candidate.sha256 ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(loras).values(row).run();
    await this.download(row);
    this.deps.log.info({ lora: id, source: row.source, base }, 'lora added');
    return this.get(id);
  }

  private async download(row: LoraRow): Promise<void> {
    await this.deps.downloads.enqueue({
      kind: 'comfy',
      bundle: LIBRARY_BUNDLE,
      slot: 'file',
      url: row.url,
      name: row.file,
      expectedBytes: row.bytes ?? undefined,
    });
  }

  /** Download a LoRA's file again: after a failure, or when it went missing. */
  async retry(id: string): Promise<LoraView> {
    const row = this.row(id);
    const view = await this.view(row);
    if (view.state === 'installed' || view.state === 'queued' || view.state === 'downloading') return view;
    // A failed download resumes from its partial file; a missing file starts over.
    if (view.download) this.deps.downloads.retry(view.download.id);
    else await this.download(row);
    return this.get(id);
  }

  async update(id: string, patch: LoraPatchInput): Promise<LoraView> {
    this.row(id);
    if (patch.base !== undefined) this.assertBase(patch.base);
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    this.deps.db
      .update(loras)
      .set({ ...changes, updatedAt: Date.now() })
      .where(eq(loras.id, id))
      .run();
    return this.get(id);
  }

  /** Remove a LoRA and its file, stopping its download if one runs. */
  async remove(id: string): Promise<void> {
    const row = this.row(id);
    for (const task of this.deps.downloads.list({ kind: 'comfy', bundle: LIBRARY_BUNDLE })) {
      if (task.name !== row.file) continue;
      if (task.status === 'queued' || task.status === 'downloading') this.deps.downloads.cancel(task.id);
      await this.deps.downloads.remove(task.id, true).catch(() => {});
    }
    const path = safeResolve(this.dir, row.file);
    await Promise.all([rm(path, { force: true }), rm(`${path}.part`, { force: true }), rm(`${path}.part.json`, { force: true })]);
    this.deps.db.delete(loras).where(eq(loras.id, id)).run();
    this.deps.storage.invalidate();
  }

  private assertBase(base: string): asserts base is LoraBaseId {
    if (!(LORA_BASE_IDS as readonly string[]).includes(base)) {
      throw errors.validation(`Unknown base "${base}" (one of ${LORA_BASE_IDS.join(', ')})`);
    }
  }

  /**
   * The LoRAs a request asks for, checked against the recipe it runs: each
   * exists, is downloaded, and was made for the recipe's base model. A LoRA
   * for another model would fail inside ComfyUI with a wall of key-mismatch
   * warnings, or worse, load and do nothing; here it is a 400 naming it.
   */
  async resolve(recipe: Recipe, workflow: WorkflowSpec, requested: LoraRequest[]): Promise<{ patches: LoraPatch[]; used: UsedLora[] }> {
    if (requested.length === 0) return { patches: [], used: [] };
    if (!recipe.lora_base || workflow.lora_targets.length === 0) {
      throw errors.validation(`${recipe.name} takes no LoRAs${recipe.lora_base ? ' in this mode' : ''}`);
    }
    const seen = new Set<string>();
    const patches: LoraPatch[] = [];
    const used: UsedLora[] = [];
    for (const request of requested) {
      if (seen.has(request.id)) throw errors.validation(`LoRA "${request.id}" is given twice`);
      seen.add(request.id);
      const row = this.deps.db.select().from(loras).where(eq(loras.id, request.id)).get();
      if (!row) throw errors.validation(`No LoRA "${request.id}" in the library`);
      if (row.base !== recipe.lora_base) {
        throw errors.validation(
          `LoRA "${row.name}" is for ${baseLabel(row.base)}; ${recipe.name} runs ${baseLabel(recipe.lora_base)}`,
        );
      }
      if (!(await this.onDisk(row.file))) throw errors.validation(`LoRA "${row.name}" is not downloaded yet`);
      const strength = request.strength ?? row.strength;
      patches.push({ name: `${LIBRARY_PREFIX}${row.file}`, strength });
      used.push({ id: row.id, name: row.name, strength });
    }
    return { patches, used };
  }
}
