import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ModelManager } from '../models/manager.js';
import type { Paths } from '../paths.js';

/**
 * llama.cpp's router discovers models by scanning `--models-dir`, and that scan
 * goes exactly one directory deep: `<dir>/<name>/*.gguf` is found,
 * `<dir>/<name>/<sub>/*.gguf` is not.
 *
 * Pepper's bundle layout puts weights one level deeper than that
 * (`models/llm/<bundle>/weights/*.gguf`, see models/bundle.ts), because one
 * layout has to serve all four kinds. The two are simply incompatible: pointing
 * `--models-dir` at `models/llm` discovers nothing at all, and every LLM bundle
 * is invisible to text generation.
 *
 * Rather than flatten the bundle layout for one backend's benefit, the app
 * generates a scan directory of symlinks in the shape llama.cpp wants:
 *
 *   cache/llm-scan/<bundle>/<weights-file>.gguf -> models/llm/<bundle>/weights/…
 *
 * This mirrors how audio.cpp is handled (services/audio-config.ts): the backend
 * gets the input shape it expects, generated fresh before each spawn, and the
 * on-disk bundle layout stays uniform. The bundle directory name is preserved
 * as the parent, so the model id llama.cpp reports still matches the bundle.
 *
 * `aux/` files (mmproj projectors) are deliberately not linked — llama.cpp
 * would load a projector as though it were a model.
 */

export const LLM_SCAN_DIR = 'llm-scan';

export interface LlmScanDirResult {
  path: string;
  modelIds: string[];
}

export async function writeLlmScanDir(
  paths: Paths,
  models: ModelManager,
  log: FastifyBaseLogger,
): Promise<LlmScanDirResult> {
  const path = join(paths.cacheDir, LLM_SCAN_DIR);

  // Rebuilt from scratch so a deleted bundle leaves no dangling link behind.
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });

  const modelIds: string[] = [];
  for (const bundle of await models.list('llm')) {
    const weights = bundle.components.filter((c) => c.slot === 'weights');
    if (weights.length === 0) {
      log.warn({ bundle: bundle.id }, 'llm bundle skipped: no weights file');
      continue;
    }

    const bundleDir = join(path, bundle.id);
    await mkdir(bundleDir, { recursive: true });
    for (const file of weights) {
      await symlink(join(paths.modelsDir, 'llm', bundle.id, 'weights', file.name), join(bundleDir, file.name));
    }
    modelIds.push(bundle.id);
  }

  return { path, modelIds };
}
