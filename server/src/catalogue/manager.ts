import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { errors } from '../errors.js';
import type { ModelKind, Paths } from '../paths.js';
import { hfResolveUrl, listRepoFiles, parseQuant } from '../util/hf.js';
import {
  catalogueSchema,
  type Catalogue,
  type CatalogueComponent,
  type CatalogueModel,
  type ComponentFileOption,
} from './types.js';

/**
 * Fetches and serves the remote model catalogue (requirement 7).
 *
 * Three layers, in order: the live remote fetch, a copy cached on the
 * persistent volume, and — if neither is available — an explicit error rather
 * than a silent empty list. The cache exists because a container restarting on
 * a flaky network should still be able to show a user what they already have
 * installed and what they could install; "the catalogue is briefly stale" is a
 * much better failure than "the catalogue is empty and the UI looks broken".
 *
 * The per-component *file* listing is a separate, live call to HuggingFace:
 * the catalogue says which repo a component comes from, HuggingFace says which
 * quantizations exist in it today. Baking the file list into the catalogue
 * would make every new quant upload a catalogue edit.
 */

const CACHE_FILE = 'catalogue.json';

export interface CatalogueState {
  loaded: boolean;
  /** Where the served catalogue came from. */
  source: 'remote' | 'cache' | 'none';
  fetchedAt?: string;
  modelCount: number;
  url: string;
  error?: string;
}

export class CatalogueManager {
  private catalogue: Catalogue | null = null;
  private fetchedAt = 0;
  private source: CatalogueState['source'] = 'none';
  private lastError: string | undefined;
  private inFlight: Promise<Catalogue> | null = null;

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly log: FastifyBaseLogger,
  ) {}

  private get cachePath(): string {
    return join(this.paths.cacheDir, CACHE_FILE);
  }

  state(): CatalogueState {
    return {
      loaded: this.catalogue !== null,
      source: this.source,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : undefined,
      modelCount: this.catalogue?.models.length ?? 0,
      url: this.config.catalogueUrl,
      error: this.lastError,
    };
  }

  /**
   * Load at startup. Never throws: a catalogue that cannot be fetched must not
   * stop the server from booting, since generation against already-installed
   * models does not depend on it at all.
   */
  async loadAtStartup(): Promise<void> {
    try {
      await this.ensureLoaded();
      this.log.info(
        { source: this.source, models: this.catalogue?.models.length ?? 0 },
        'model catalogue loaded',
      );
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn({ err: this.lastError, url: this.config.catalogueUrl }, 'catalogue unavailable');
    }
  }

  /** The catalogue, refetching when the TTL has expired. */
  async ensureLoaded(force = false): Promise<Catalogue> {
    const fresh = this.catalogue && Date.now() - this.fetchedAt < this.config.catalogueTtlMs;
    if (fresh && !force) return this.catalogue!;

    // Coalesce: several UI panels asking at once must not each hit the network.
    if (this.inFlight) return this.inFlight;

    const promise = this.fetchWithFallback(force);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchWithFallback(force: boolean): Promise<Catalogue> {
    try {
      const catalogue = await this.fetchRemote();
      this.catalogue = catalogue;
      this.fetchedAt = Date.now();
      this.source = 'remote';
      this.lastError = undefined;
      await this.writeCache(catalogue);
      return catalogue;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn({ err: this.lastError }, 'catalogue fetch failed, falling back to cache');

      // A stale in-memory copy still beats nothing, and beats re-reading a
      // cache file that produced it.
      if (this.catalogue && !force) return this.catalogue;

      const cached = await this.readCache();
      if (cached) {
        this.catalogue = cached;
        this.source = 'cache';
        return cached;
      }
      throw errors.catalogueUnavailable(
        `Could not load the model catalogue from ${this.config.catalogueUrl}: ${this.lastError}`,
      );
    }
  }

  private async fetchRemote(): Promise<Catalogue> {
    const res = await fetch(this.config.catalogueUrl, {
      headers: { 'User-Agent': 'pepper', Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const parsed = catalogueSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new Error(`Catalogue failed validation: ${parsed.error.issues[0]?.message}`);
    }

    // A duplicate id would make "install this one" ambiguous and silently
    // install whichever the lookup happened to hit first.
    const seen = new Set<string>();
    for (const model of parsed.data.models) {
      const key = `${model.kind}/${model.id}`;
      if (seen.has(key)) throw new Error(`Catalogue contains a duplicate model id: ${key}`);
      seen.add(key);
    }

    return parsed.data;
  }

  private async writeCache(catalogue: Catalogue): Promise<void> {
    try {
      await writeFile(this.cachePath, JSON.stringify(catalogue), 'utf8');
    } catch (err) {
      // A read-only or full cache directory is not worth failing the request
      // that triggered the fetch.
      this.log.warn({ err: (err as Error).message }, 'could not write catalogue cache');
    }
  }

  private async readCache(): Promise<Catalogue | null> {
    try {
      const parsed = catalogueSchema.safeParse(JSON.parse(await readFile(this.cachePath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async list(filter: { kind?: ModelKind; search?: string } = {}): Promise<CatalogueModel[]> {
    const catalogue = await this.ensureLoaded();
    const search = filter.search?.toLowerCase();

    return catalogue.models.filter((model) => {
      if (filter.kind && model.kind !== filter.kind) return false;
      if (!search) return true;
      return (
        model.id.toLowerCase().includes(search) ||
        model.name.toLowerCase().includes(search) ||
        (model.description?.toLowerCase().includes(search) ?? false) ||
        model.tags.some((tag) => tag.toLowerCase().includes(search))
      );
    });
  }

  async get(id: string): Promise<CatalogueModel> {
    const catalogue = await this.ensureLoaded();
    const model = catalogue.models.find((m) => m.id === id);
    if (!model) throw errors.modelNotFound(id);
    return model;
  }

  /**
   * The files available for one component, live from its source repo — this is
   * what populates the quantization picker.
   */
  async componentFiles(
    model: CatalogueModel,
    component: CatalogueComponent,
    signal?: AbortSignal,
  ): Promise<ComponentFileOption[]> {
    const { source } = component;

    // A direct URL is a single fixed file with nothing to choose between.
    if (source.url) {
      const filename = decodeURIComponent(new URL(source.url).pathname.split('/').pop() ?? 'weights');
      return [{ path: filename, filename, size: 0, quant: parseQuant(filename), url: source.url }];
    }

    const files = await listRepoFiles(source.repo, source.path, this.config.hfToken, signal);
    const extensions = source.extensions ?? DEFAULT_EXTENSIONS;
    const match = source.match?.toLowerCase();

    return files
      .filter((file) => {
        const filename = file.path.split('/').pop() ?? file.path;
        const lower = filename.toLowerCase();
        if (!extensions.some((ext) => lower.endsWith(ext))) return false;
        if (match && !lower.includes(match)) return false;
        if (SHARD_RE.test(lower)) return false;
        if (component.role !== 'llm_vision' && isProjector(lower)) return false;
        if (isDraftModel(lower)) return false;
        return true;
      })
      .map((file) => {
        const filename = file.path.split('/').pop() ?? file.path;
        return {
          path: file.path,
          filename,
          size: file.size,
          quant: parseQuant(filename),
          url: hfResolveUrl(source.repo, file.path),
        };
      })
      .sort((a, b) => a.size - b.size);
  }
}

const DEFAULT_EXTENSIONS = ['.gguf', '.safetensors', '.bin', '.pt', '.ckpt', '.json', '.txt'];

/**
 * Multi-part shards (`model-00001-of-00003.gguf`). The download manager fetches
 * one file per component, so a lone shard would install as a silently
 * truncated, unusable bundle — and nothing downstream detects a partial file.
 * Excluded outright rather than surfaced with a warning.
 */
const SHARD_RE = /-\d{5}-of-\d{5}\.[a-z]+$/;

/** Vision projectors, which belong to the `llm_vision` role and nowhere else. */
function isProjector(filename: string): boolean {
  return filename.includes('mmproj');
}

/**
 * Speculative-decoding draft weights, which several newer repos ship alongside
 * the real ones. Loading one as the model produces a working server that
 * generates noticeably worse output — the worst kind of wrong.
 */
function isDraftModel(filename: string): boolean {
  return /^(mtp|dflash|eagle3)-/.test(filename) || filename.includes('-draft');
}
