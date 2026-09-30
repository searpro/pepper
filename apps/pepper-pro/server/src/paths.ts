import { join } from 'node:path';
import { buildCorePaths, ensureCoreDirs, type Paths } from '@pepper/core/paths.js';
import type { ProConfig } from './config.js';

/**
 * Pepper Pro's layout on the shared `DATA_DIR` tree: models in ComfyUI's own
 * folders, so one file serves every recipe that names it and the paths a
 * workflow refers to are the paths on disk.
 *
 *   DATA_DIR/models/<comfy folder>/<file>   diffusion_models, text_encoders, vae, loras…
 *   DATA_DIR/models/llm/<bundle>/           GGUF models for llama.cpp
 *   DATA_DIR/cache/comfy/                   ComfyUI's user dir, temp and raw outputs
 *   DATA_DIR/projects/                      project assets that must outlive output retention
 */

export interface ProPaths extends Paths {
  llmDir: string;
  comfyUserDir: string;
  comfyTempDir: string;
  /** Where ComfyUI writes; finished outputs are moved from here into `outputDir`. */
  comfyOutputDir: string;
  /** The generated `extra_model_paths.yaml` pointing ComfyUI at `modelsDir`. */
  comfyModelPathsFile: string;
  projectsDir: string;
}

/**
 * ComfyUI's model folders that recipes may file downloads under. A recipe
 * naming any other folder is rejected when it is loaded.
 */
export const COMFY_FOLDERS = [
  'checkpoints',
  'diffusion_models',
  'text_encoders',
  'vae',
  'loras',
  'upscale_models',
  'latent_upscale_models',
  'audio_encoders',
  'clip_vision',
  'model_patches',
  'embeddings',
  'controlnet',
  'style_models',
  'seedvr2',
] as const;
export type ComfyFolder = (typeof COMFY_FOLDERS)[number];

export function buildPaths(config: ProConfig): ProPaths {
  const core = buildCorePaths(config, 'pepper-pro.db');
  const comfyCache = join(core.cacheDir, 'comfy');
  return {
    ...core,
    llmDir: join(core.modelsDir, 'llm'),
    comfyUserDir: join(comfyCache, 'user'),
    comfyTempDir: join(comfyCache, 'temp'),
    comfyOutputDir: join(comfyCache, 'output'),
    comfyModelPathsFile: join(comfyCache, 'extra_model_paths.yaml'),
    projectsDir: join(core.dataDir, 'projects'),
  };
}

export async function ensureDirs(paths: ProPaths): Promise<void> {
  await ensureCoreDirs(paths, [
    paths.llmDir,
    paths.comfyUserDir,
    paths.comfyTempDir,
    paths.comfyOutputDir,
    paths.projectsDir,
    ...COMFY_FOLDERS.map((folder) => join(paths.modelsDir, folder)),
  ]);
}
