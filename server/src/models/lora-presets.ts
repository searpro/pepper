import { z } from 'zod';

/**
 * Sampling settings a LoRA was trained for. Few-step distillation LoRAs
 * (turbo, lightning, DMD) produce ghosted or smeared images on the base
 * model's schedule, so the Image screen offers these as one click.
 */
export const loraPresetSchema = z.object({
  steps: z.number().int().min(1).optional(),
  cfg_scale: z.number().min(0).optional(),
  /**
   * Denoising schedule, highest noise first, without the terminal 0. Passed to
   * sd-cli as `--sigmas` after `sigma_shift` (if any) is applied.
   */
  sigmas: z.array(z.number().min(0)).optional(),
  /**
   * diffusers' resolution-dependent ("dynamic") exponential time shift, for
   * schedules published as pre-shift values. `mu` is interpolated linearly on
   * the latent token count between the two sequence lengths.
   */
  sigma_shift: z
    .object({
      base_shift: z.number(),
      max_shift: z.number(),
      base_seq_len: z.number(),
      max_seq_len: z.number(),
    })
    .optional(),
  note: z.string().optional(),
});

export type LoraPreset = z.infer<typeof loraPresetSchema>;

/** Qwen-Image's scheduler_config.json values. */
const QWEN_DYNAMIC_SHIFT = { base_shift: 0.5, max_shift: 0.9, base_seq_len: 256, max_seq_len: 8192 };

const VIGGLE_6STEP: LoraPreset = {
  steps: 6,
  cfg_scale: 1,
  sigmas: [1.0, 0.9375, 0.875, 0.75, 0.5, 0.25],
  sigma_shift: QWEN_DYNAMIC_SHIFT,
};

/**
 * Presets for published LoRAs, keyed by filename without extension, from each
 * model card's reference code. A bundle's `lora_presets` overrides these.
 */
export const KNOWN_LORA_PRESETS: Record<string, LoraPreset> = {
  // huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo — the 5step files are
  // sampled on the same 6-step schedule as v0.2.1, per the card.
  'Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256': VIGGLE_6STEP,
  'Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128': VIGGLE_6STEP,
  'Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r256': VIGGLE_6STEP,
  'Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r128': VIGGLE_6STEP,
  'Qwen-Image-2.1-viggle-turbo-4step-lora-r64': {
    steps: 4,
    cfg_scale: 1,
    note: 'v0.1, kept for reference; ghosts on a plain 4-step schedule. Prefer v0.2.1.',
  },
  // huggingface.co/PrunaAI/Pruna-Qwen-Image-2.1 — schedules used as given.
  'p_qwen_image_2.1_8step_v0.1': {
    steps: 8,
    cfg_scale: 1,
    sigmas: [1.0, 14 / 15, 6 / 7, 10 / 13, 2 / 3, 6 / 11, 0.4, 2 / 9],
    note: 'Use one Pruna adapter at a time.',
  },
  'p_qwen_image_2.1_5step_v0.1': {
    steps: 5,
    cfg_scale: 1,
    sigmas: [1.0, 0.94, 6 / 7, 2 / 3, 0.4],
    note: 'Use one Pruna adapter at a time.',
  },
};
