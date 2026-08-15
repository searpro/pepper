import { mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { BackendId, Config } from './config.js';
import { errors } from './errors.js';

/**
 * The `DATA_DIR` layout (requirement 9).
 *
 * sd-api took each directory as an independent env var, which meant a
 * deployment could half-configure itself — models on the persistent volume,
 * binaries on ephemeral disk — and only find out after a redeploy silently
 * deleted a 40GB download. Here `DATA_DIR` is the only knob and every
 * persisted path is derived from it:
 *
 *   DATA_DIR/
 *     bin/<backend>/        installed backend binaries + their sibling libs
 *     models/<kind>/<bundle>/   weights, one directory per bundle
 *     uploads/              user-uploaded inputs (init images, voice refs)
 *     db/pepper.db          SQLite database
 *     cache/                catalogue snapshot, generated backend configs
 *
 * `OUTPUT_DIR` is deliberately *not* part of this tree — see `Config.outputDir`.
 */

/** Model kinds, matching the `models/<kind>/` sub-directories. */
export const MODEL_KINDS = ['image', 'video', 'audio', 'llm'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export function isModelKind(value: string): value is ModelKind {
  return (MODEL_KINDS as readonly string[]).includes(value);
}

export interface Paths {
  dataDir: string;
  binDir: string;
  modelsDir: string;
  uploadsDir: string;
  dbDir: string;
  dbFile: string;
  cacheDir: string;
  outputDir: string;
}

export function buildPaths(config: Config): Paths {
  const dataDir = config.dataDir;
  return {
    dataDir,
    binDir: join(dataDir, 'bin'),
    modelsDir: join(dataDir, 'models'),
    uploadsDir: join(dataDir, 'uploads'),
    dbDir: join(dataDir, 'db'),
    dbFile: join(dataDir, 'db', 'pepper.db'),
    cacheDir: join(dataDir, 'cache'),
    outputDir: config.outputDir,
  };
}

/** Create every directory the app expects to exist. Safe to call repeatedly. */
export async function ensureDirs(paths: Paths): Promise<void> {
  const dirs = [
    paths.dataDir,
    paths.binDir,
    paths.modelsDir,
    paths.uploadsDir,
    paths.dbDir,
    paths.cacheDir,
    paths.outputDir,
    ...MODEL_KINDS.map((kind) => join(paths.modelsDir, kind)),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/** Install directory for one backend's binaries. */
export function backendBinDir(paths: Paths, backend: BackendId): string {
  return join(paths.binDir, backend);
}

/** Root directory holding every bundle of one model kind. */
export function kindDir(paths: Paths, kind: ModelKind): string {
  return join(paths.modelsDir, kind);
}

/** A single model bundle's directory: `models/<kind>/<bundle>/`. */
export function bundleDir(paths: Paths, kind: ModelKind, bundle: string): string {
  return safeResolve(kindDir(paths, kind), bundle);
}

// --- Path safety ------------------------------------------------------------
//
// Every name that reaches the filesystem comes from a request body, a URL
// segment or a remote catalogue, so none of them are trusted. A name is one
// path segment: no separators, no traversal, no absolute paths.

export function assertSafeName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw errors.invalidPath('Name must be a non-empty string');
  }
  if (name.includes('\0')) {
    throw errors.invalidPath('Name contains a null byte');
  }
  if (name === '.' || name === '..') {
    throw errors.invalidPath(`Name must not be "${name}"`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw errors.invalidPath(`Name must not contain path separators or "..": ${name}`);
  }
  if (isAbsolute(name)) {
    throw errors.invalidPath(`Name must not be an absolute path: ${name}`);
  }
  return name;
}

/** Resolve `name` inside `baseDir`, confirming the result stays inside it. */
export function safeResolve(baseDir: string, name: string): string {
  assertSafeName(name);
  const base = resolve(baseDir);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw errors.invalidPath(`Resolved path escapes base directory: ${name}`);
  }
  return target;
}

/**
 * Resolve a nested path (e.g. `lora/style.safetensors`) inside `baseDir`,
 * validating each segment. Used for bundle components, which legitimately live
 * one directory deeper than the bundle root.
 */
export function safeResolveNested(baseDir: string, ...segments: string[]): string {
  let current = resolve(baseDir);
  for (const segment of segments) {
    current = safeResolve(current, segment);
  }
  return current;
}

/** Defensive: strip any directory component a caller may have included. */
export function sanitizeBasename(name: string): string {
  return basename(name);
}
