import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { errors } from '../errors.js';
import {
  assertSafeName,
  bundleDir,
  kindDir,
  isModelKind,
  MODEL_KINDS,
  safeResolve,
  type ModelKind,
  type Paths,
} from '../paths.js';
import { listDirs } from '../util/files.js';
import {
  componentPath,
  inspectBundle,
  readManifest,
  resolveImageBundle,
  slotDirName,
  writeManifest,
  type BundleInfo,
  type ComponentSlot,
  type ModelManifest,
  type ResolvedImageBundle,
} from './bundle.js';

/**
 * The installed-model catalogue, backed by the filesystem (requirement 8:
 * "use filesystem based scanning for listing the downloaded models").
 *
 * Nothing about the model list lives in the database. A model *is* the files
 * on disk: an operator can drop a bundle onto the volume, a download can be
 * interrupted, a directory can be deleted out from under the app, and in every
 * one of those cases the disk is right and a database row would be a lie the
 * UI then shows the user. Scanning costs a `readdir` per bundle, which is
 * nothing against the multi-gigabyte reads that follow.
 */

export interface ComponentPaths {
  dir: string;
  finalPath: string;
  /** In-progress download; promoted to `finalPath` only on success. */
  tmpPath: string;
  /** Sidecar holding resume metadata (url, total). */
  metaPath: string;
}

export class ModelManager {
  constructor(
    private readonly paths: Paths,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Every bundle of one kind, or of all kinds. */
  async list(kind?: ModelKind): Promise<BundleInfo[]> {
    const kinds = kind ? [kind] : [...MODEL_KINDS];
    const out: BundleInfo[] = [];

    for (const k of kinds) {
      const root = kindDir(this.paths, k);
      for (const id of await listDirs(root)) {
        try {
          out.push(await inspectBundle(join(root, id), id, k));
        } catch (err) {
          // One malformed bundle (bad model.json, unreadable directory) must
          // not blank the whole list — the UI's job is to show the user which
          // one is broken, which it can only do if the rest still render.
          this.log.warn({ kind: k, id, err: (err as Error).message }, 'skipping unreadable bundle');
        }
      }
    }

    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(kind: ModelKind, id: string): Promise<BundleInfo> {
    const dir = bundleDir(this.paths, kind, id);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) throw errors.modelNotFound(id);
    } catch {
      throw errors.modelNotFound(id);
    }
    return inspectBundle(dir, id, kind);
  }

  /**
   * Find a bundle by id when the caller did not say which kind it is — the
   * shape sd-api's `/v1/generate` used, where `model` is a bare name.
   * Preference order matters: an image request naming a bundle that exists
   * under both `image/` and `video/` means the image one.
   */
  async find(id: string, prefer: ModelKind[] = [...MODEL_KINDS]): Promise<BundleInfo | null> {
    for (const kind of prefer) {
      try {
        return await this.get(kind, id);
      } catch {
        // Not this kind; keep looking.
      }
    }
    return null;
  }

  async resolveImage(id: string, kinds: ModelKind[] = ['image', 'video']): Promise<ResolvedImageBundle> {
    for (const kind of kinds) {
      const dir = bundleDir(this.paths, kind, id);
      try {
        await stat(dir);
      } catch {
        continue;
      }
      return resolveImageBundle(dir, id, kind);
    }
    throw errors.modelNotFound(id);
  }

  /** Create an empty bundle, optionally with a manifest. */
  async create(kind: ModelKind, id: string, manifest?: ModelManifest): Promise<BundleInfo> {
    assertSafeName(id);
    const dir = bundleDir(this.paths, kind, id);
    await mkdir(dir, { recursive: true });
    if (manifest) await writeManifest(dir, { kind, ...manifest });
    this.log.info({ kind, id }, 'model bundle created');
    return this.get(kind, id);
  }

  async updateManifest(kind: ModelKind, id: string, manifest: ModelManifest): Promise<BundleInfo> {
    const dir = bundleDir(this.paths, kind, id);
    const existing = await readManifest(dir).catch(() => null);
    await writeManifest(dir, { kind, ...existing, ...manifest });
    return this.get(kind, id);
  }

  /** Delete a whole bundle and everything in it. */
  async remove(kind: ModelKind, id: string): Promise<void> {
    const dir = bundleDir(this.paths, kind, id);
    await rm(dir, { recursive: true, force: true });
    this.log.info({ kind, id }, 'model bundle deleted');
  }

  /** Delete a single component file from a bundle. */
  async removeComponent(
    kind: ModelKind,
    id: string,
    slot: ComponentSlot,
    name: string,
  ): Promise<void> {
    const paths = await this.componentPaths(kind, id, slot, name);
    await rm(paths.finalPath, { force: true });
    // A partially-downloaded file under the same name is part of the same
    // component; leaving it behind would make a "deleted" file reappear as a
    // resumable partial.
    await rm(paths.tmpPath, { force: true });
    await rm(paths.metaPath, { force: true });
    this.log.info({ kind, id, slot, name }, 'model component deleted');
  }

  /** Rename a bundle. */
  async rename(kind: ModelKind, id: string, nextId: string): Promise<BundleInfo> {
    assertSafeName(nextId);
    const from = bundleDir(this.paths, kind, id);
    const to = bundleDir(this.paths, kind, nextId);
    try {
      await stat(to);
      throw errors.validation(`A "${kind}" model named "${nextId}" already exists`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err;
    }
    await rename(from, to);
    return this.get(kind, nextId);
  }

  /**
   * Where a component's files live. Creates the slot directory, which is what
   * makes requirement 8's "other (specify) — this will generate the specified
   * directory" work without a separate code path.
   */
  async componentPaths(
    kind: ModelKind,
    bundle: string,
    slot: ComponentSlot,
    name: string,
  ): Promise<ComponentPaths> {
    const dir = join(bundleDir(this.paths, kind, bundle), slotDirName(slot));
    await mkdir(dir, { recursive: true });
    const finalPath = safeResolve(dir, this.validateFileName(name));
    return {
      dir,
      finalPath,
      tmpPath: `${finalPath}.part`,
      metaPath: `${finalPath}.part.json`,
    };
  }

  /** Absolute path of an existing component file. */
  componentFile(kind: ModelKind, bundle: string, slot: ComponentSlot, name: string): string {
    return componentPath(bundleDir(this.paths, kind, bundle), slot, name);
  }

  /**
   * Derive a filename from an explicit name or the URL's last segment.
   *
   * The `model.json` guard is not hypothetical: a component download whose
   * name came from a remote catalogue could otherwise overwrite the manifest
   * sitting next to it, turning a bundle into an unreadable one on a
   * mistyped catalogue entry.
   */
  fileNameFor(url: string, explicit?: string): string {
    if (explicit) return this.validateFileName(explicit);

    let candidate: string;
    try {
      candidate = basename(new URL(url).pathname);
    } catch {
      throw errors.validation(`Cannot derive a filename from URL: ${url}`);
    }
    if (!candidate) throw errors.validation(`Cannot derive a filename from URL: ${url}`);
    return this.validateFileName(decodeURIComponent(candidate));
  }

  private validateFileName(name: string): string {
    assertSafeName(name);
    if (name.toLowerCase() === 'model.json') {
      throw errors.validation('"model.json" is the bundle manifest and cannot be written as a component');
    }
    if (name.endsWith('.part') || name.endsWith('.part.json')) {
      throw errors.validation('Component filenames cannot end in .part or .part.json');
    }
    return name;
  }

  /** Parse a `<kind>` path segment, rejecting anything unknown. */
  static parseKind(value: string): ModelKind {
    if (!isModelKind(value)) {
      throw errors.validation(`Unknown model kind "${value}". Expected one of ${MODEL_KINDS.join(', ')}.`);
    }
    return value;
  }
}
