import { extname } from 'node:path';
import type { GenerateParams, HiresParams } from '../schemas/generate.js';
import type { ResolvedImageBundle, ClipRole } from '../models/bundle.js';
import { presetSigmas, type LoraPreset } from '../models/lora-presets.js';

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
  fps: '--fps',
} as const;

/** The flag each resolved weight component is passed under. */
export const WEIGHT_FLAG: Record<ClipRole | 'vae' | 'audio_vae', string> = {
  vae: '--vae',
  audio_vae: '--audio-vae',
  clip_l: '--clip_l',
  clip_g: '--clip_g',
  clip_vision: '--clip_vision',
  t5xxl: '--t5xxl',
  llm: '--llm',
  llm_vision: '--llm_vision',
};

/** sd-cli's built-in hires upscalers; anything else names a model file. */
export const BUILTIN_HIRES_UPSCALERS = [
  'Latent',
  'Latent (nearest)',
  'Latent (nearest-exact)',
  'Latent (antialiased)',
  'Latent (bicubic)',
  'Latent (bicubic antialiased)',
  'Lanczos',
  'Nearest',
];

/** A hires pass resolved against the model's defaults, with where its upscaler lives. */
export interface ResolvedHires extends Omit<HiresParams, 'enabled'> {
  /** Directory holding the upscaler model, when `upscaler` names one. */
  upscalersDir?: string;
}

/**
 * The model's recommended hires pass with the request's fields laid over it.
 * `undefined` when neither asks for one or the request turns it off.
 */
export function mergeHires(
  defaults: Partial<HiresParams> | undefined,
  request: Partial<HiresParams> | undefined,
): Omit<HiresParams, 'enabled'> | undefined {
  if (!defaults && !request) return undefined;
  const merged = { ...defaults, ...request };
  if (merged.enabled === false) return undefined;
  // A request that only says { enabled: true } on a model without defaults
  // still gets sd-cli's own defaults (2x, Latent, 0.7).
  const { enabled: _enabled, ...rest } = merged;
  return rest;
}

/**
 * Where sd-cli should look for a named hires upscaler: the bundle's `aux/`
 * folder first (a model-specific latent upscaler such as LTX-2's), then the
 * shared ESRGAN folder. Built-in names need no directory.
 */
export function resolveHiresUpscaler(
  name: string | undefined,
  bundle: Pick<ResolvedImageBundle, 'auxDir' | 'auxFiles'>,
  upscaleDir: string,
  upscaleFiles: string[],
): { upscaler?: string; upscalersDir?: string } {
  if (!name || BUILTIN_HIRES_UPSCALERS.includes(name)) return { upscaler: name };
  const stem = (file: string) => file.slice(0, file.length - extname(file).length);
  if (bundle.auxDir && bundle.auxFiles.some((file) => stem(file) === name)) {
    return { upscaler: name, upscalersDir: bundle.auxDir };
  }
  if (upscaleFiles.some((file) => stem(file) === name)) return { upscaler: name, upscalersDir: upscaleDir };
  throw new Error(
    `Hires upscaler "${name}" is neither built in (${BUILTIN_HIRES_UPSCALERS.join(', ')}) ` +
      "nor installed in this model's aux folder or the upscalers folder.",
  );
}

/**
 * The schedule a distillation LoRA was trained for, when one in the request
 * has a preset with a step count. Only the first such LoRA counts: two
 * distillation LoRAs at once is not a combination any preset describes.
 */
export function loraSchedule(
  loras: GenerateParams['loras'],
  presets: Record<string, LoraPreset>,
  width: number,
  height: number,
): { lora: string; steps?: number; cfg_scale?: number; sigmas?: number[] } | undefined {
  for (const lora of loras ?? []) {
    const preset = presets[lora.name];
    if (!preset?.steps) continue;
    return {
      lora: lora.name,
      steps: preset.steps,
      cfg_scale: preset.cfg_scale,
      sigmas: presetSigmas(preset, width, height),
    };
  }
  return undefined;
}

export interface InputImages {
  init?: string;
  /** Flag `init` is passed under. Defaults to `-i`. */
  initFlag?: string;
  mask?: string;
  refs?: string[];
}

export interface AudioConditioning {
  /** Absolute path to the WAV the model conditions on. */
  path: string;
  /** The flag it is passed under, from the bundle's `s2v.audio_flag`. */
  flag: string;
}

export interface BuildArgsInput {
  /** Parameters with the bundle's manifest defaults already merged under them. */
  params: GenerateParams;
  bundle: ResolvedImageBundle;
  outputPath: string;
  images?: InputImages;
  /** Speech conditioning, for a single speech-to-video chunk. */
  audio?: AudioConditioning;
  /** Second, higher-resolution pass, already merged and resolved. */
  hires?: ResolvedHires;
  /**
   * Process-wide flags from the user's backend settings (threads, VAE tiling,
   * flash attention). Appended before the manifest's own extras so a
   * model-specific flag still wins on a conflict.
   */
  backendArgs?: string[];
}

/**
 * Appends `<lora:name:weight>` for each selected LoRA. sd-cli strips the tags
 * from the text before encoding it, so they only select weights. Names are
 * checked against the bundle before this is reached; the character filter is
 * a second line of defence against a name closing the tag early.
 */
export function withLoraTags(
  prompt: string,
  loras: GenerateParams['loras'],
  highNoiseExpert = false,
): string {
  const tags = (loras ?? [])
    .filter((lora) => /^[^<>:|]+$/.test(lora.name))
    .map((lora) =>
      // On a two-expert model (Wan 2.2 A14B), LoRAs are published in pairs and
      // the high-noise half must load into the high-noise expert, which sd-cli
      // spells <lora:|high_noise|name:w>.
      highNoiseExpert && isHighNoiseLora(lora.name)
        ? `<lora:|high_noise|${lora.name}:${lora.weight ?? 1}>`
        : `<lora:${lora.name}:${lora.weight ?? 1}>`,
    );
  return tags.length ? `${prompt} ${tags.join(' ')}` : prompt;
}

/** Does a LoRA filename mark it as the high-noise half of a Wan 2.2 pair? */
export function isHighNoiseLora(name: string): boolean {
  return /high[_-]?noise/i.test(name);
}

export function buildImageArgs(input: BuildArgsInput): string[] {
  const { params, bundle, outputPath, images, audio, hires, backendArgs = [] } = input;
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

  // Wan 2.2 splits denoising across two experts: the high-noise one runs the
  // early steps, the low-noise one the rest. sd-cli takes the low-noise expert
  // as the ordinary diffusion model and the other under its own flag.
  if (bundle.highNoisePath) {
    args.push('--high-noise-diffusion-model', bundle.highNoisePath);
  }

  for (const [role, flag] of Object.entries(WEIGHT_FLAG) as [
    ClipRole | 'vae' | 'audio_vae',
    string,
  ][]) {
    const path = bundle.weights[role];
    if (path) args.push(flag, path);
  }

  // The flag name comes from the bundle rather than a constant here, because
  // it is the one piece of S2V wiring that varies between model families.
  if (audio) {
    args.push(audio.flag, audio.path);
    // Wan 2.2 S2V needs its wav2vec2 speech encoder passed alongside the audio
    // (sd-cli's `--audio-encoder`, the default in S2V_DEFAULTS). Emitted only
    // when the bundle actually has an encoder in `aux/`.
    if (bundle.s2v?.audioEncoderFlag && bundle.audioEncoderPath) {
      args.push(bundle.s2v.audioEncoderFlag, bundle.audioEncoderPath);
    }
  }

  // `initFlag` lets the speech path route the chained frame to `-r` instead:
  // MiniMax-H3's Ref2VA rejects `--init-img` when reference conditioning is in
  // play, so the same conceptual input needs a different flag per model.
  if (images?.init) args.push(images.initFlag ?? '-i', images.init);
  if (images?.mask) args.push('--mask', images.mask);
  for (const ref of images?.refs ?? []) args.push('-r', ref);
  if (params.strength !== undefined) args.push('--strength', String(params.strength));
  if (params.img_cfg_scale !== undefined) args.push('--img-cfg-scale', String(params.img_cfg_scale));
  if (params.increase_ref_index) args.push('--increase-ref-index');

  // LoRAs are activated from the prompt via <lora:name:mult>; this only tells
  // sd-cli where to look for them.
  if (bundle.loraDir) args.push('--lora-model-dir', bundle.loraDir);

  args.push('-o', outputPath);
  args.push(FLAG_MAP.prompt, withLoraTags(params.prompt, params.loras, Boolean(bundle.highNoisePath)));

  if (params.negative_prompt) args.push(FLAG_MAP.negative_prompt, params.negative_prompt);
  if (params.steps !== undefined) args.push(FLAG_MAP.steps, String(params.steps));
  if (params.cfg_scale !== undefined) args.push(FLAG_MAP.cfg_scale, String(params.cfg_scale));
  if (params.width !== undefined) args.push(FLAG_MAP.width, String(params.width));
  if (params.height !== undefined) args.push(FLAG_MAP.height, String(params.height));
  if (params.seed !== undefined) args.push(FLAG_MAP.seed, String(params.seed));
  if (params.sampler) args.push(FLAG_MAP.sampler, params.sampler);
  if (params.scheduler) args.push('--scheduler', params.scheduler);
  if (params.sigmas?.length) args.push('--sigmas', params.sigmas.join(','));

  // Wan 2.2's high-noise expert has its own step count, CFG and sampler. They
  // follow the main ones unless the model says otherwise, so a Lightning
  // preset's 4 steps at CFG 1 applies to both experts.
  if (bundle.highNoisePath) {
    const highNoise = bundle.defaults.high_noise ?? {};
    // A high-noise LoRA (the Lightning pair) brings its own schedule, which
    // the main steps/CFG already carry.
    const pairedLora = params.loras?.some((lora) => isHighNoiseLora(lora.name)) ?? false;
    const steps = pairedLora ? params.steps : (highNoise.steps ?? params.steps);
    const cfg = pairedLora ? params.cfg_scale : (highNoise.cfg_scale ?? params.cfg_scale);
    const sampler = highNoise.sampler ?? params.sampler;
    if (steps !== undefined) args.push('--high-noise-steps', String(steps));
    if (cfg !== undefined) args.push('--high-noise-cfg-scale', String(cfg));
    if (sampler) args.push('--high-noise-sampling-method', sampler);
  }

  if (hires) {
    args.push('--hires');
    if (hires.upscalersDir) args.push('--hires-upscalers-dir', hires.upscalersDir);
    if (hires.upscaler) args.push('--hires-upscaler', hires.upscaler);
    if (hires.width !== undefined && hires.height !== undefined) {
      args.push('--hires-width', String(hires.width), '--hires-height', String(hires.height));
    } else if (hires.scale !== undefined) {
      args.push('--hires-scale', String(hires.scale));
    }
    if (hires.steps !== undefined) args.push('--hires-steps', String(hires.steps));
    if (hires.denoise !== undefined) args.push('--hires-denoising-strength', String(hires.denoise));
    if (hires.sigmas?.length) args.push('--hires-sigmas', hires.sigmas.join(','));
  }

  // Video parameters. I2V's conditioning image reuses -i above.
  if (params.video_frames !== undefined) {
    args.push(FLAG_MAP.video_frames, String(params.video_frames));
  }
  if (params.flow_shift !== undefined) args.push(FLAG_MAP.flow_shift, String(params.flow_shift));
  if (params.fps !== undefined) args.push(FLAG_MAP.fps, String(params.fps));

  args.push(...backendArgs);
  args.push(...bundle.extraArgs);

  return args;
}
