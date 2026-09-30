import { join } from 'node:path';
import { z } from 'zod';
import {
  bool,
  enumOf,
  loadCoreConfig,
  num,
  path,
  positiveNum,
  repo,
  type CoreConfig,
} from '@pepper/core/config.js';

export { publicConfig } from '@pepper/core/config.js';

/**
 * Pepper Pro's configuration: the shared `CoreConfig` plus ComfyUI, llama.cpp
 * and the hardware tier. Environment-driven like everything else (see
 * `@pepper/core/config.ts`).
 */

/**
 * Hardware classes recipes are tested against (docs/PEPPER-PRO.md §9.1). A
 * recipe's files and defaults are chosen per tier, so an install never puts a
 * Q4 file on a card that could run INT8, or an INT8 file on a host whose RAM
 * cannot hold it.
 */
export const TIERS = ['24gb-64ram', '32gb', '48gb', '96gb'] as const;
export type Tier = (typeof TIERS)[number];

export const LICENCE_MODES = ['personal', 'commercial'] as const;
export type LicenceMode = (typeof LICENCE_MODES)[number];

export interface ProConfig extends CoreConfig {
  tier: Tier;
  /** Default licence mode for new projects and the recipe filter. */
  licenceMode: LicenceMode;

  /** The ComfyUI checkout (the directory holding `main.py`). */
  comfyDir: string;
  /** The interpreter ComfyUI runs under, with its pinned environment. */
  comfyPython: string;
  /** Loopback port ComfyUI listens on. Never public: its API has no authentication. */
  comfyPort: number;
  /**
   * Custom node packs ComfyUI may load (directory names under
   * `custom_nodes/`). Everything else is disabled, so a node pack is only
   * ever code that was pinned into the image.
   */
  comfyNodes: string[];
  /** Restart ComfyUI after this many jobs (0: never), to return fragmented memory. */
  comfyRecycleJobs: number;
  /**
   * Keep models loaded between jobs of the same recipe family. On a large
   * card this is what makes auditioning takes fast; on a small one the
   * memory is better returned.
   */
  comfyKeepWarm: boolean;
  /** Ceiling on one ComfyUI job. Video finishing runs long. */
  comfyTimeoutMs: number;

  llamacppPort: number;
  llamacppTimeoutMs: number;
  llamacppReleaseRepo: string;

  /** Where the recipe templates shipped with the app live. */
  recipesDir: string;
}

const tierSchema = z.enum(TIERS);
const licenceSchema = z.enum(LICENCE_MODES);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProConfig {
  const core = loadCoreConfig(env, {
    outputDirName: 'pepper-pro-outputs',
    catalogueUrl: 'https://raw.githubusercontent.com/searpro/pepper-catalogue/main/pepper-pro-recipes.json',
  });

  const comfyDir = path(env.COMFY_DIR?.trim() || join(core.dataDir, 'comfy', 'ComfyUI'));
  return {
    ...core,
    tier: enumOf('PEPPER_TIER', tierSchema, env.PEPPER_TIER, '32gb'),
    licenceMode: enumOf('LICENCE_MODE', licenceSchema, env.LICENCE_MODE, 'personal'),

    comfyDir,
    comfyPython: env.COMFY_PYTHON?.trim() ? path(env.COMFY_PYTHON.trim()) : 'python3',
    comfyPort: positiveNum('COMFY_PORT', env.COMFY_PORT, 8188),
    comfyNodes: (env.COMFY_NODES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    comfyRecycleJobs: num('COMFY_RECYCLE_JOBS', env.COMFY_RECYCLE_JOBS, 40),
    comfyKeepWarm: bool('COMFY_KEEP_WARM', env.COMFY_KEEP_WARM, true),
    comfyTimeoutMs: positiveNum('COMFY_TIMEOUT', env.COMFY_TIMEOUT, 3_600_000),

    llamacppPort: positiveNum('LLAMACPP_PORT', env.LLAMACPP_PORT, 8090),
    llamacppTimeoutMs: num('LLAMACPP_TIMEOUT', env.LLAMACPP_TIMEOUT, 300_000),
    llamacppReleaseRepo: repo('LLAMACPP_RELEASE_REPO', env.LLAMACPP_RELEASE_REPO, 'searpro/llama.cpp'),

    recipesDir: path(env.RECIPES_DIR?.trim() || new URL('../recipes', import.meta.url).pathname),
  };
}
