import { join } from 'node:path';
import type { Config } from './config.js';
import {
  buildCorePaths,
  ensureCoreDirs,
  safeResolve,
  type Paths,
} from '@pepper/core/paths.js';

export {
  assertSafeName,
  backendBinDir,
  safeResolve,
  safeResolveNested,
  sanitizeBasename,
  type Paths,
} from '@pepper/core/paths.js';

/**
 * Pepper's model layout on top of the shared `DATA_DIR` tree
 * (`core/paths.ts`): `models/<kind>/<bundle>/`, one directory per bundle.
 */

/** Model kinds, matching the `models/<kind>/` sub-directories. */
export const MODEL_KINDS = ['image', 'video', 'audio', 'llm'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export function isModelKind(value: string): value is ModelKind {
  return (MODEL_KINDS as readonly string[]).includes(value);
}

export function buildPaths(config: Config): Paths {
  return buildCorePaths(config, 'pepper.db');
}

/** Create every directory the app expects to exist. Safe to call repeatedly. */
export async function ensureDirs(paths: Paths): Promise<void> {
  await ensureCoreDirs(
    paths,
    MODEL_KINDS.map((kind) => join(paths.modelsDir, kind)),
  );
}

/** Root directory holding every bundle of one model kind. */
export function kindDir(paths: Paths, kind: ModelKind): string {
  return join(paths.modelsDir, kind);
}

/** A single model bundle's directory: `models/<kind>/<bundle>/`. */
export function bundleDir(paths: Paths, kind: ModelKind, bundle: string): string {
  return safeResolve(kindDir(paths, kind), bundle);
}
