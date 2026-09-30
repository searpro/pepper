import { mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { CoreConfig } from './config.js';
import { errors } from './errors.js';

/**
 * The shared part of the `DATA_DIR` layout (requirement 9).
 *
 * sd-api took each directory as an independent env var, which meant a
 * deployment could half-configure itself — models on the persistent volume,
 * binaries on ephemeral disk — and only find out after a redeploy silently
 * deleted a 40GB download. Here `DATA_DIR` is the only knob and every
 * persisted path is derived from it:
 *
 *   DATA_DIR/
 *     bin/<backend>/        installed backend binaries + their sibling libs
 *     models/               weights, laid out as the product decides
 *     uploads/              user-uploaded inputs (init images, voice refs)
 *     db/<product>.db       SQLite database
 *     cache/                catalogue snapshot, generated backend configs
 *
 * `OUTPUT_DIR` is deliberately *not* part of this tree — see `CoreConfig.outputDir`.
 */

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

export function buildCorePaths(config: CoreConfig, dbName: string): Paths {
  const dataDir = config.dataDir;
  return {
    dataDir,
    binDir: join(dataDir, 'bin'),
    modelsDir: join(dataDir, 'models'),
    uploadsDir: join(dataDir, 'uploads'),
    dbDir: join(dataDir, 'db'),
    dbFile: join(dataDir, 'db', dbName),
    cacheDir: join(dataDir, 'cache'),
    outputDir: config.outputDir,
  };
}

/** Create every shared directory, plus `extra`. Safe to call repeatedly. */
export async function ensureCoreDirs(paths: Paths, extra: string[] = []): Promise<void> {
  const dirs = [
    paths.dataDir,
    paths.binDir,
    paths.modelsDir,
    paths.uploadsDir,
    paths.dbDir,
    paths.cacheDir,
    paths.outputDir,
    ...extra,
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/** Install directory for one backend's binaries. */
export function backendBinDir(paths: Paths, backend: string): string {
  return join(paths.binDir, backend);
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
