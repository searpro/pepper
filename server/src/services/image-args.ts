import type { GenerateParams } from '../schemas/generate.js';
import type { ResolvedImageBundle, ClipRole } from '../models/bundle.js';

/**
 * Maps API parameters to stable-diffusion.cpp flags.
 *
 * Data-driven so the mapping stays auditable when the upstream CLI drifts, and
 * every value is pushed as a discrete argv element — never concatenated into a
 * shell string — so a prompt cannot inject an extra flag.
 */

export const FLAG_MAP = {
  prompt: '-p',
  negative_prompt: '-n',
  steps: '--steps',
  cfg_scale: '--cfg-scale',
  width: '-W',
  height: '-H',
  seed: '-s',
  sampler: '--sampling-method',
  video_frames: '--video-frames',
  flow_shift: '--flow-shift',
} as const;

/** The flag each resolved weight component is passed under. */
export const WEIGHT_FLAG: Record<ClipRole | 'vae', string> = {
  vae: '--vae',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  clip_vision: '--clip_vision',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
};

export interface InputImages {
  init?: string;
  mask?: string;
  refs?: string[];
}

export interface BuildArgsInput {
  /** Parameters with the bundle's manifest defaults already merged under them. */
  params: GenerateParams;
  bundle: ResolvedImageBundle;
  outputPath: string;
  images?: InputImages;
  /**
   * Process-wide flags from the user's backend settings (threads, VAE tiling,
   * flash attention). Appended before the manifest's own extras so a
   * model-specific flag still wins on a conflict.
   */
  backendArgs?: string[];
}

export function buildImageArgs(input: BuildArgsInput): string[] {
  const { params, bundle, outputPath, images, backendArgs = [] } = input;
  const args: string[] = [];

  // Switches sd-cli into video generation. Must come before the model flags.
  if (bundle.mode === 'video') args.push('-M', 'vid_gen');

  // A full checkpoint loads with -m; a bare diffusion model uses
  // --diffusion-model and brings its VAE and text encoders alongside.
  if (bundle.loadMode === 'diffusion-model') {
    args.push('--diffusion-model', bundle.checkpointPath);
  } else {
    args.push('-m', bundle.checkpointPath);
  }

  for (const [role, flag] of Object.entries(WEIGHT_FLAG) as [ClipRole | 'vae', string][]) {
    const path = bundle.weights[role];
    if (path) args.push(flag, path);
  }

  if (images?.init) args.push('-i', images.init);
  if (images?.mask) args.push('--mask', images.mask);
  for (const ref of images?.refs ?? []) args.push('-r', ref);
  if (params.strength !== undefined) args.push('--strength', String(params.strength));
  if (params.img_cfg_scale !== undefined) args.push('--img-cfg-scale', String(params.img_cfg_scale));
  if (params.increase_ref_index) args.push('--increase-ref-index');

  // LoRAs are activated from the prompt via <lora:name:mult>; this only tells
  // sd-cli where to look for them.
  if (bundle.loraDir) args.push('--lora-model-dir', bundle.loraDir);

  args.push('-o', outputPath);
  args.push(FLAG_MAP.prompt, params.prompt);

  if (params.negative_prompt) args.push(FLAG_MAP.negative_prompt, params.negative_prompt);
  if (params.steps !== undefined) args.push(FLAG_MAP.steps, String(params.steps));
  if (params.cfg_scale !== undefined) args.push(FLAG_MAP.cfg_scale, String(params.cfg_scale));
  if (params.width !== undefined) args.push(FLAG_MAP.width, String(params.width));
  if (params.height !== undefined) args.push(FLAG_MAP.height, String(params.height));
  if (params.seed !== undefined) args.push(FLAG_MAP.seed, String(params.seed));
  if (params.sampler) args.push(FLAG_MAP.sampler, params.sampler);

  // Video parameters. I2V's conditioning image reuses -i above.
  if (params.video_frames !== undefined) {
    args.push(FLAG_MAP.video_frames, String(params.video_frames));
  }
  if (params.flow_shift !== undefined) args.push(FLAG_MAP.flow_shift, String(params.flow_shift));

  args.push(...backendArgs);
  args.push(...bundle.extraArgs);

  return args;
}
