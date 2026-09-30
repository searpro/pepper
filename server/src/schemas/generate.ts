import { z } from 'zod';

/**
 * Request/response schemas for image and video generation.
 *
 * Field-for-field compatible with sd-api (requirement 11: "API contract should
 * be fully compatible with the current sd-api"), including the snake_case
 * naming and the both-pairs-optional response shape. New fields are additive
 * and optional, so an existing client's request body still validates and its
 * response parsing still finds every key it looks for.
 */

/** Sampling methods stable-diffusion.cpp accepts for `--sampling-method`. */
export const SAMPLERS = [
  'euler',
  'euler_a',
  'heun',
  'dpm2',
  'dpm++2s_a',
  'dpm++2m',
  'dpm++2mv2',
  'ipndm',
  'ipndm_v',
  'lcm',
  'ddim_trailing',
  'tcd',
] as const;

/**
 * sd-cli's second "highres fix" pass: upscale the first result, then denoise it
 * again at the larger size. This is what turns a distilled model's soft 1 MP
 * output into a crisp one, and how LTX-2 renders 720p from a cheap 360p pass
 * through its latent upscaler.
 */
export const hiresSchema = z.object({
  enabled: z.boolean().default(true),
  /** Output size relative to the first pass; ignored when width/height are set. */
  scale: z.number().min(1).max(4).optional(),
  width: z.number().int().min(64).optional(),
  height: z.number().int().min(64).optional(),
  /** Steps for the second pass (sd-cli defaults to the first pass's count). */
  steps: z.number().int().min(1).max(200).optional(),
  /** How much the second pass may change the upscaled image (sd-cli default 0.7). */
  denoise: z.number().min(0).max(1).optional(),
  /** Explicit refine schedule for the second pass (LTX-2's is 0.85, 0.725, 0.421875, 0). */
  sigmas: z.array(z.number().min(0).max(1000)).min(2).max(201).optional(),
  /**
   * `Latent`, `Lanczos`, `Nearest` and the other sd-cli built-ins, or the name
   * (filename without extension) of an upscaler model: one in the bundle's
   * `aux/` folder (LTX-2's latent upscaler) or an installed ESRGAN checkpoint.
   */
  upscaler: z.string().min(1).optional(),
});

export type HiresParams = z.infer<typeof hiresSchema>;

export const generateSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  /** Bundle id under `models/image/` or `models/video/`. */
  model: z.string().min(1, 'model is required'),
  /**
   * Which file in the bundle's `checkpoint/` folder to load, for a model with
   * several (quantizations, fine-tunes). Defaults to the manifest's choice,
   * else the largest.
   */
  checkpoint: z.string().optional(),

  negative_prompt: z.string().optional(),
  steps: z.number().int().min(1).max(200).optional(),
  cfg_scale: z.number().min(0).max(30).optional(),
  width: z.number().int().min(64).optional(),
  height: z.number().int().min(64).optional(),
  seed: z.number().int().min(-1).optional(),
  sampler: z.enum(SAMPLERS).optional(),
  /** sd-cli `--scheduler` (karras, exponential, simple, beta, …); default is model-specific. */
  scheduler: z
    .string()
    .regex(/^[a-z_]+$/, 'scheduler must be an sd-cli scheduler name')
    .optional(),
  /** Second, higher-resolution denoising pass. Overrides the model's default; `{ enabled: false }` turns it off. */
  hires: hiresSchema.partial().optional(),
  /**
   * `auto` (default) runs a distillation LoRA (turbo, lightning, few-step) on
   * the schedule it was trained for, whatever steps/CFG were sent — off that
   * schedule it can only produce overcooked or ghosted images. `off` sends the
   * request's own values unchanged.
   */
  lora_schedule: z.enum(['auto', 'off']).optional(),

  // --- img2img / editing. Names refer to files uploaded via POST /v1/inputs. ---
  init_image: z.string().optional(),
  strength: z.number().min(0).max(1).optional(),
  mask: z.string().optional(),
  /** Reference images for edit models (Kontext, Qwen-Image-Edit, …). */
  ref_images: z.array(z.string()).max(16).optional(),
  increase_ref_index: z.boolean().optional(),
  img_cfg_scale: z.number().min(0).max(30).optional(),

  // --- Video (Wan T2V/I2V). I2V's conditioning image reuses `init_image`. ---
  video_frames: z.number().int().min(1).max(257).optional(),
  flow_shift: z.number().min(0).optional(),
  fps: z.number().int().min(1).max(60).optional(),

  // --- Speech-to-video ---
  /**
   * Name of an uploaded audio file, from POST /v1/inputs. Its presence is what
   * makes a request speech-to-video: the model still needs a prompt and may
   * still take `init_image` as the speaker's portrait.
   */
  audio: z.string().optional(),
  /**
   * Seconds of audio per generated chunk. Defaults to the model's window;
   * raising it past what the model was trained on degrades lip-sync rather
   * than failing, which is why it is exposed but not encouraged.
   */
  audio_chunk_seconds: z.number().min(0.5).max(30).optional(),
  /** Seconds each chunk replays from the previous one, to blend the seam. */
  audio_overlap_seconds: z.number().min(0).max(5).optional(),

  // --- Additions ---
  /**
   * LoRAs from the bundle's `lora/` directory, by filename without extension.
   * Applied as `<lora:name:weight>` tags, which is also how sd-api clients can
   * still pass them inline in the prompt.
   */
  loras: z
    .array(
      z.object({
        name: z.string().min(1),
        weight: z.number().min(-4).max(4).optional(),
      }),
    )
    .max(8)
    .optional(),
  /**
   * Custom denoising schedule, highest noise first, ending in 0 (sd-cli's
   * `--sigmas`). Distilled LoRAs need the schedule they were trained on; sd-cli
   * takes the step count from its length.
   */
  sigmas: z.array(z.number().min(0).max(1000)).min(2).max(201).optional(),
  /** Number of images to produce; each becomes its own job. */
  batch: z.number().int().min(1).max(16).optional(),

  // --- Character Studio ---
  /** The character this generation features; recorded for the Media page. */
  character_id: z.string().optional(),
  /**
   * Set by the Character Studio on its own sheet/portrait jobs: the output is
   * attached to the character when the job completes.
   */
  character_role: z.enum(['sheet', 'portrait', 'reference']).optional(),
});

export type GenerateParams = z.infer<typeof generateSchema>;

export const generateResultSchema = z.object({
  // Exactly one pair is populated, per `metadata.kind`. Both stay optional
  // rather than repurposing the image fields for video, so a client that only
  // knows about images reads `undefined` instead of a path it cannot play.
  image_path: z.string().optional(),
  image_url: z.string().optional(),
  video_path: z.string().optional(),
  video_url: z.string().optional(),
  metadata: z.object({
    kind: z.enum(['image', 'video']).optional(),
    prompt: z.string(),
    model: z.string(),
    seed: z.number().optional(),
    steps: z.number().optional(),
    cfg_scale: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    sampler: z.string().optional(),
    video_frames: z.number().optional(),
    flow_shift: z.number().optional(),
    fps: z.number().optional(),
    /** Speech-to-video only: how the run was split, and over how much audio. */
    audio_duration_s: z.number().optional(),
    audio_chunks: z.number().optional(),
    checkpoint: z.string().optional(),
    loras: z.array(z.object({ name: z.string(), weight: z.number().optional() })).optional(),
    sigmas: z.array(z.number()).optional(),
    duration_ms: z.number(),
  }),
});

/**
 * Audio and text job bodies.
 *
 * These are the queued counterparts of the OpenAI-compatible `/v1/audio/speech`
 * and `/v1/llm/*` routes, which stay synchronous proxies for sd-api clients and
 * for token streaming. Both pass through unknown keys, because the sampling
 * knobs each backend accepts are its own business and change upstream faster
 * than a schema here could track.
 */
export const audioJobSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    input: z.string().min(1, 'input is required'),
    /** A configured preset name, or a model-native built-in speaker id. */
    voice: z.string().optional(),
    /** Name of an uploaded reference clip, for voice cloning. */
    voice_ref: z.string().optional(),
    /** Voice direction. Required by voice-design models. */
    instructions: z.string().optional(),
  })
  .passthrough();

/** Song or instrumental from an audio.cpp music model (ACE-Step, HeartMuLa, Stable Audio). */
export const musicJobSchema = z.object({
  model: z.string().min(1, 'model is required'),
  prompt: z.string().min(1, 'prompt is required').describe('Style: genre, instruments, mood, vocal type, tempo.'),
  lyrics: z.string().max(20000).optional().describe('Lyrics with [Verse]/[Chorus] markers; omit for instrumental.'),
  duration_seconds: z.number().min(1).max(600).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  seed: z.number().int().min(-1).optional(),
  task_route: z.string().regex(/^[a-z0-9-]+$/).optional(),
});

export const textJobSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(z.unknown()).min(1).optional(),
    prompt: z.string().min(1).optional(),
  })
  .passthrough()
  .refine((body) => Boolean(body.messages) !== Boolean(body.prompt), {
    message: 'Provide exactly one of "messages" or "prompt"',
  });

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const jobSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'video', 'audio', 'text']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  progress: z.number(),
  step: z.number().optional(),
  totalSteps: z.number().optional(),
  params: z.record(z.unknown()),
  result: z.record(z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  attempts: z.number(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

/**
 * Reject a request whose dimensions are absurd before a model is loaded.
 *
 * Not a safety rail so much as a courtesy: sd-cli will happily accept
 * 16384x16384, spend several minutes allocating, and then be OOM-killed along
 * with the server. Failing in 400 microseconds with a message is better.
 */
export function validateDimensions(params: GenerateParams, maxDim: number): void {
  for (const field of ['width', 'height'] as const) {
    const value = params[field];
    if (value !== undefined && value > maxDim) {
      throw new Error(`${field} must be at most ${maxDim}`);
    }
    if (value !== undefined && value % 8 !== 0) {
      throw new Error(`${field} must be a multiple of 8`);
    }
  }
}
