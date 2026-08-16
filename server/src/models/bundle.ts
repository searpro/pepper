import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { errors } from '../errors.js';
import { assertSafeName, safeResolve, type ModelKind } from '../paths.js';
import { listFiles, stripExt, type FileEntry } from '../util/files.js';

/**
 * The model bundle layout (requirement 8: "each model should go into its own
 * directory (bundle name)", under `DATA_DIR/models/<kind>/<bundle-name>/`).
 *
 * One layout serves all four kinds, because the thing that varies between an
 * image model and an LLM is *which* component directories are populated, not
 * how a bundle is structured:
 *
 *   models/<kind>/<bundle>/
 *     model.json      manifest (optional for image/llm, required for audio)
 *     checkpoint/     diffusion model or full checkpoint   (-m | --diffusion-model)
 *     vae/            standalone VAE                       (--vae)
 *     clip/           text encoders: clip_l/clip_g/t5xxl/llm/clip_vision
 *     lora/           LoRAs, activated by <lora:name:mult> in the prompt
 *     weights/        GGUF weights for llm and audio bundles
 *     aux/            mmproj, vocoders, speaker embeddings, tokenizers
 *     <anything>/     requirement 8's "other (specify)" — created on demand
 *
 * sd-api had three parallel implementations of this (`models/`, `llm-models/`,
 * `audio-models/`) that had already diverged in their allowed extensions and
 * their manifest rules. Collapsing them means the download manager, the
 * catalogue installer and the UI each have one shape to handle, and a new kind
 * costs a `KIND_SLOTS` entry rather than a new module tree.
 */

/** Component sub-directories with a defined meaning. */
export const KNOWN_SLOTS = ['checkpoint', 'vae', 'clip', 'lora', 'weights', 'aux'] as const;
export type KnownSlot = (typeof KNOWN_SLOTS)[number];

/**
 * A component slot: one of the known ones, or `other:<dirname>` for
 * requirement 8's "other (specify) — this will generate the specified
 * directory and keeps the file there".
 */
export type ComponentSlot = KnownSlot | `other:${string}`;

/** Which slots each kind offers in the UI. Storage allows any of them. */
export const KIND_SLOTS: Record<ModelKind, KnownSlot[]> = {
  image: ['checkpoint', 'vae', 'clip', 'lora'],
  video: ['checkpoint', 'vae', 'clip', 'lora'],
  audio: ['weights', 'aux'],
  llm: ['weights', 'aux'],
};

export function isKnownSlot(value: string): value is KnownSlot {
  return (KNOWN_SLOTS as readonly string[]).includes(value);
}

/** Resolve a slot to its directory name, validating the "other" case. */
export function slotDirName(slot: ComponentSlot): string {
  if (isKnownSlot(slot)) return slot;
  const custom = slot.slice('other:'.length);
  // A user-typed directory name goes straight to the filesystem, so it gets
  // the same single-segment treatment as every other untrusted name.
  return assertSafeName(custom);
}

export function parseSlot(value: string): ComponentSlot {
  if (isKnownSlot(value)) return value;
  if (value.startsWith('other:')) {
    slotDirName(value as ComponentSlot);
    return value as ComponentSlot;
  }
  throw errors.validation(
    `Unknown component slot "${value}". Expected one of ${KNOWN_SLOTS.join(', ')} or "other:<directory>".`,
  );
}

/** Text-encoder roles within `clip/`, each mapping to a specific sd-cli flag. */
export type ClipRole = 'clip_l' | 'clip_g' | 'clip_vision' | 't5xxl' | 'llm' | 'llm_vision';

export const CLIP_ROLES: ClipRole[] = ['clip_l', 'clip_g', 'clip_vision', 't5xxl', 'llm', 'llm_vision'];

export type LoadMode = 'model' | 'diffusion-model';
export type GenerationMode = 'image' | 'video';

export const manifestSchema = z.object({
  /** Friendly display name. Defaults to the bundle directory name. */
  name: z.string().optional(),
  /** Which generation surface this bundle belongs to. */
  kind: z.enum(['image', 'video', 'audio', 'llm']).optional(),
  /** Force the checkpoint load flag; otherwise auto-detected. */
  load: z.enum(['auto', 'model', 'diffusion-model']).optional(),
  /** `video` switches sd-cli into `-M vid_gen` and writes .webm. */
  mode: z.enum(['image', 'video']).optional(),
  /**
   * What this bundle can do beyond plain generation, e.g. `s2v` for a model
   * that conditions on speech. Declared rather than inferred: whether a
   * checkpoint accepts audio is a property of how it was trained, and guessing
   * from the filename would offer the Speech to Video tab a model that silently
   * ignores the audio it is given.
   */
  capabilities: z.array(z.string()).optional(),
  /** Speech-to-video wiring. Only read when `capabilities` includes "s2v". */
  s2v: z
    .object({
      /**
       * The backend flag the audio file is passed under. Configurable because
       * this is the one part of S2V that differs per model family — sd-cli
       * exposes MiniMax-H3's as `--ref-audio`, and a future Wan S2V may well
       * land under another name. Keeping it in the manifest means supporting
       * that model is a catalogue edit, not a release.
       */
      audio_flag: z.string().optional(),
      /** Frames the model emits per chunk. Wan's window is 81. */
      frames_per_chunk: z.number().optional(),
      /** Seconds of audio per chunk, including the overlap. */
      chunk_seconds: z.number().optional(),
      /** Seconds each chunk replays from the previous one, to blend seams. */
      overlap_seconds: z.number().optional(),
      /**
       * The flag the chained frame is passed under. Defaults to `-i`
       * (init image), but MiniMax-H3's Ref2VA rejects `--init-img` outright
       * when reference conditioning is in play and takes `-r` instead, so this
       * cannot be a constant.
       */
      chain_flag: z.string().optional(),
      /**
       * Round each chunk's frame count up to `stride * k + offset`. MiniMax-H3
       * aligns to a 17k+5 grid and silently rounds up on its own, which would
       * make every segment slightly longer than the audio it covers and drift
       * the stitch out of sync.
       */
      frame_grid: z.object({ stride: z.number(), offset: z.number() }).optional(),
      /** Resample chunks to what the audio encoder expects. */
      sample_rate: z.number().optional(),
      /**
       * Whether the trailing frame of chunk N seeds chunk N+1 as an init
       * image. Keeps a subject from being re-imagined at every seam, but only
       * works on a model that accepts image conditioning.
       */
      chain_frames: z.boolean().optional(),
    })
    .optional(),
  /** Explicit component filenames, overriding auto-detection. */
  components: z
    .object({
      checkpoint: z.string().optional(),
      /** Wan 2.2's high-noise expert, loaded alongside the low-noise one. */
      checkpoint_high_noise: z.string().optional(),
      vae: z.string().optional(),
      /** Separate audio VAE, for models that decode a soundtrack (MiniMax-H3). */
      audio_vae: z.string().optional(),
      clip_l: z.string().optional(),
      clip_g: z.string().optional(),
      clip_vision: z.string().optional(),
      t5xxl: z.string().optional(),
      llm: z.string().optional(),
      llm_vision: z.string().optional(),
    })
    .optional(),
  /** Generation parameters applied when a request omits them. */
  defaults: z
    .object({
      steps: z.number().optional(),
      cfg_scale: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      sampler: z.string().optional(),
      negative_prompt: z.string().optional(),
      video_frames: z.number().optional(),
      flow_shift: z.number().optional(),
      fps: z.number().optional(),
    })
    .optional(),
  /** Raw backend flags appended verbatim. */
  extra_args: z.array(z.string()).optional(),
  // --- audio.cpp ---
  /** audio.cpp model family, matching its `model_specs/<family>.json`. */
  family: z.string().optional(),
  /** What the audio model does: tts | asr | voice-design | voice-conversion. */
  task: z.string().optional(),
  /** Optional audio.cpp mode qualifier. */
  audio_mode: z.string().optional(),
  /**
   * Named voice presets for cloning/design models, selectable as `voice` on
   * /v1/audio/speech. Values are passed through to audio.cpp untouched, since
   * which fields a preset carries is a property of the family, not of us.
   */
  voicePresets: z.record(z.record(z.unknown())).optional(),
  /** Preset used when a request names no voice. */
  defaultVoicePreset: z.string().optional(),
  /** Where this bundle was installed from, for the UI's provenance display. */
  source: z
    .object({
      catalogueId: z.string().optional(),
      repo: z.string().optional(),
      quant: z.string().optional(),
    })
    .optional(),
});

export type ModelManifest = z.infer<typeof manifestSchema>;

export interface ComponentFile extends FileEntry {
  slot: ComponentSlot;
  /** Only for `clip/` files: which encoder flag this maps to. */
  role?: ClipRole;
  /** Only for `lora/` files: how the prompt refers to it. */
  ref?: string;
}

/** An interrupted download left on disk, resumable. */
export interface PartialFile {
  slot: ComponentSlot;
  /** Final filename, without the `.part` suffix. */
  name: string;
  received: number;
  total: number | null;
}

export interface BundleInfo {
  id: string;
  kind: ModelKind;
  name: string;
  manifest: ModelManifest | null;
  loadMode: LoadMode;
  mode: GenerationMode;
  components: ComponentFile[];
  partials: PartialFile[];
  /** Declared extras such as `s2v`. Surfaced so the UI can filter on them. */
  capabilities: string[];
  size: number;
  modified: string;
  /** Whether the bundle has enough on disk to generate with. */
  ready: boolean;
  /** Why it is not ready, when it is not. */
  readyReason?: string;
}

/** Resolved speech-to-video settings, with every default already applied. */
export interface S2vConfig {
  audioFlag: string;
  framesPerChunk: number;
  chunkSeconds: number;
  overlapSeconds: number;
  sampleRate?: number;
  chainFrames: boolean;
  chainFlag: string;
  frameGrid?: { stride: number; offset: number };
}

/**
 * Wan's published S2V window: 81 frames at 16fps is a little over five
 * seconds, and the 0.5s overlap is what the seam blend consumes.
 */
export const S2V_DEFAULTS: S2vConfig = {
  audioFlag: '--ref-audio',
  framesPerChunk: 81,
  chunkSeconds: 5,
  overlapSeconds: 0.5,
  chainFrames: true,
  chainFlag: '-i',
};

/** Everything the image/video generator needs, with absolute paths. */
export interface ResolvedImageBundle {
  id: string;
  dir: string;
  displayName: string;
  loadMode: LoadMode;
  mode: GenerationMode;
  checkpointPath: string;
  /** Wan 2.2's high-noise expert, when the bundle ships one. */
  highNoisePath?: string;
  weights: Partial<Record<ClipRole | 'vae' | 'audio_vae', string>>;
  defaults: NonNullable<ModelManifest['defaults']>;
  extraArgs: string[];
  loraDir?: string;
  capabilities: string[];
  /** Populated only when `capabilities` includes "s2v". */
  s2v?: S2vConfig;
}

/** Does a checkpoint filename mark it as the high-noise expert? */
export function isHighNoiseCheckpoint(filename: string): boolean {
  return /high[_-]?noise|highnoise|[_-]high[_.-]/i.test(filename);
}

export function resolveS2vConfig(manifest: ModelManifest | null): S2vConfig {
  const declared = manifest?.s2v;
  return {
    audioFlag: declared?.audio_flag ?? S2V_DEFAULTS.audioFlag,
    framesPerChunk: declared?.frames_per_chunk ?? S2V_DEFAULTS.framesPerChunk,
    chunkSeconds: declared?.chunk_seconds ?? S2V_DEFAULTS.chunkSeconds,
    overlapSeconds: declared?.overlap_seconds ?? S2V_DEFAULTS.overlapSeconds,
    sampleRate: declared?.sample_rate,
    chainFrames: declared?.chain_frames ?? S2V_DEFAULTS.chainFrames,
    chainFlag: declared?.chain_flag ?? S2V_DEFAULTS.chainFlag,
    frameGrid: declared?.frame_grid,
  };
}

/** Round a frame count up onto a model's permitted grid. */
export function alignFrames(frames: number, grid?: { stride: number; offset: number }): number {
  if (!grid || grid.stride <= 0) return frames;
  const k = Math.max(0, Math.ceil((frames - grid.offset) / grid.stride));
  return grid.stride * k + grid.offset;
}

export async function readManifest(dir: string): Promise<ModelManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'model.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw errors.invalidModel(`Cannot read model.json: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw errors.invalidModel(`Invalid model.json: ${(err as Error).message}`);
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw errors.invalidModel(`Invalid model.json: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}

export async function writeManifest(dir: string, manifest: ModelManifest): Promise<ModelManifest> {
  const validated = manifestSchema.parse(manifest);
  await writeFile(join(dir, 'model.json'), JSON.stringify(validated, null, 2), 'utf8');
  return validated;
}

/**
 * Map a `clip/` filename to its encoder role. Order matters: `mmproj` and
 * `clip_vision` are checked before the generic families, since a file can
 * legitimately match both (`mmproj-qwen…` is a vision projector, not the LLM
 * encoder).
 */
export function detectClipRole(filename: string): ClipRole | null {
  const n = filename.toLowerCase();
  if (/mmproj/.test(n)) return 'llm_vision';
  if (/clip[_-]?vision|clip_vit/.test(n)) return 'clip_vision';
  if (/clip[_-]?l\b|clip[_-]?l[._-]/.test(n)) return 'clip_l';
  if (/clip[_-]?g\b|clip[_-]?g[._-]/.test(n)) return 'clip_g';
  if (/t5xxl|t5[_-]?xxl|\bt5\b/.test(n)) return 't5xxl';
  if (/qwen|mistral|gemma|llama|\bllm\b|umt5/.test(n)) return 'llm';
  return null;
}

function manifestRoleFor(manifest: ModelManifest | null, filename: string): ClipRole | null {
  const components = manifest?.components;
  if (!components) return null;
  for (const role of CLIP_ROLES) {
    if (components[role] === filename) return role;
  }
  return null;
}

/** Directories present in a bundle, including any "other (specify)" ones. */
async function bundleSlots(dir: string): Promise<ComponentSlot[]> {
  const { listDirs } = await import('../util/files.js');
  const dirs = await listDirs(dir);
  return dirs.map((name) => (isKnownSlot(name) ? name : (`other:${name}` as ComponentSlot)));
}

async function listPartials(dir: string, slot: ComponentSlot): Promise<PartialFile[]> {
  const entries = await listFiles(dir, { includePartials: true });
  const out: PartialFile[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.part')) continue;
    let total: number | null = null;
    try {
      const meta = JSON.parse(await readFile(join(dir, `${entry.name}.json`), 'utf8')) as {
        total?: number | null;
      };
      total = typeof meta.total === 'number' ? meta.total : null;
    } catch {
      // No sidecar: the size is still known, the target is not.
    }
    out.push({
      slot,
      name: entry.name.slice(0, -'.part'.length),
      received: entry.size,
      total,
    });
  }
  return out;
}

/** Inspect a bundle directory. Never throws on incomplete contents. */
export async function inspectBundle(
  bundlePath: string,
  id: string,
  kind: ModelKind,
): Promise<BundleInfo> {
  const manifest = await readManifest(bundlePath).catch(() => null);
  const slots = await bundleSlots(bundlePath);

  const components: ComponentFile[] = [];
  const partials: PartialFile[] = [];

  for (const slot of slots) {
    const slotDir = join(bundlePath, slotDirName(slot));
    for (const file of await listFiles(slotDir)) {
      components.push({
        ...file,
        slot,
        role:
          slot === 'clip'
            ? (manifestRoleFor(manifest, file.name) ?? detectClipRole(file.name) ?? undefined)
            : undefined,
        ref: slot === 'lora' ? stripExt(file.name) : undefined,
      });
    }
    partials.push(...(await listPartials(slotDir, slot)));
  }

  const size = components.reduce((total, file) => total + file.size, 0);
  let modified = new Date(0).toISOString();
  try {
    modified = (await stat(bundlePath)).mtime.toISOString();
  } catch {
    // Bundle vanished mid-scan.
  }

  const readiness = assessReadiness(kind, components, manifest);

  return {
    id,
    kind,
    name: manifest?.name ?? id,
    manifest,
    loadMode: resolveLoadMode(manifest, components),
    mode: manifest?.mode ?? (kind === 'video' ? 'video' : 'image'),
    components,
    partials,
    capabilities: manifest?.capabilities ?? [],
    size,
    modified,
    ready: readiness.ready,
    readyReason: readiness.reason,
  };
}

function assessReadiness(
  kind: ModelKind,
  components: ComponentFile[],
  manifest: ModelManifest | null,
): { ready: boolean; reason?: string } {
  const has = (slot: ComponentSlot) => components.some((c) => c.slot === slot);

  if (kind === 'image' || kind === 'video') {
    return has('checkpoint')
      ? { ready: true }
      : { ready: false, reason: 'No checkpoint file in checkpoint/' };
  }
  if (kind === 'llm') {
    return has('weights') ? { ready: true } : { ready: false, reason: 'No weights file in weights/' };
  }
  // audio.cpp cannot register a bundle without knowing its family and task —
  // that information is not derivable from the files, so a bundle missing it
  // is genuinely unusable rather than merely undocumented.
  if (!has('weights')) return { ready: false, reason: 'No weights file in weights/' };
  if (!manifest?.family || !manifest?.task) {
    return { ready: false, reason: 'model.json must declare "family" and "task" for audio models' };
  }
  return { ready: true };
}

function resolveLoadMode(manifest: ModelManifest | null, components: ComponentFile[]): LoadMode {
  const declared = manifest?.load;
  if (declared === 'model' || declared === 'diffusion-model') return declared;
  // Auto: standalone VAE or text encoders mean the checkpoint is a bare
  // diffusion model rather than a full one.
  const split = components.some((c) => c.slot === 'vae' || c.slot === 'clip');
  return split ? 'diffusion-model' : 'model';
}

/** Pick a file within a slot: the manifest's choice, else the largest. */
function pickFile(files: ComponentFile[], explicit?: string): ComponentFile | null {
  if (explicit) return files.find((f) => f.name === explicit) ?? null;
  if (files.length <= 1) return files[0] ?? null;
  return [...files].sort((a, b) => b.size - a.size)[0];
}

/** Resolve an image/video bundle for generation. Throws if unusable. */
export async function resolveImageBundle(
  bundlePath: string,
  id: string,
  kind: ModelKind,
): Promise<ResolvedImageBundle> {
  const info = await inspectBundle(bundlePath, id, kind);
  if (!info.ready) throw errors.invalidModel(`Model "${id}" is not ready: ${info.readyReason}`);

  const bySlot = (slot: ComponentSlot) => info.components.filter((c) => c.slot === slot);

  // Wan 2.2 ships two experts in one bundle. The high-noise one is separated
  // out first so the ordinary "largest file wins" pick below cannot land on
  // it — loading the high-noise expert as the only diffusion model produces
  // noise, not a picture, and does so without erroring.
  const checkpoints = bySlot('checkpoint');
  const declaredHigh = info.manifest?.components?.checkpoint_high_noise;
  const highNoise = declaredHigh
    ? (checkpoints.find((file) => file.name === declaredHigh) ?? null)
    : checkpoints.length > 1
      ? (checkpoints.find((file) => isHighNoiseCheckpoint(file.name)) ?? null)
      : null;

  const lowNoise = checkpoints.filter((file) => file !== highNoise);
  const checkpoint = pickFile(lowNoise, info.manifest?.components?.checkpoint);
  if (!checkpoint) throw errors.invalidModel(`Model "${id}" has no checkpoint file`);

  const weights: Partial<Record<ClipRole | 'vae' | 'audio_vae', string>> = {};

  // A model that decodes its own soundtrack (MiniMax-H3) ships two VAEs in one
  // slot. They are separated by name before the pick, for the same reason the
  // high-noise expert is: "largest wins" would otherwise hand the video VAE
  // flag an audio decoder.
  const vaeFiles = bySlot('vae');
  const declaredAudioVae = info.manifest?.components?.audio_vae;
  const audioVae = declaredAudioVae
    ? (vaeFiles.find((file) => file.name === declaredAudioVae) ?? null)
    : (vaeFiles.find((file) => /audio/i.test(file.name)) ?? null);

  const vae = pickFile(
    vaeFiles.filter((file) => file !== audioVae),
    info.manifest?.components?.vae,
  );
  if (vae) weights.vae = join(bundlePath, 'vae', vae.name);
  if (audioVae) weights.audio_vae = join(bundlePath, 'vae', audioVae.name);

  for (const file of bySlot('clip')) {
    const role = file.role;
    // An unmapped encoder is skipped rather than guessed at: passing a text
    // encoder under the wrong flag produces garbage output, not an error.
    if (!role || weights[role]) continue;
    weights[role] = join(bundlePath, 'clip', file.name);
  }

  const loras = bySlot('lora');
  const capabilities = info.capabilities;

  return {
    id,
    dir: bundlePath,
    displayName: info.name,
    loadMode: info.loadMode,
    mode: info.mode,
    checkpointPath: join(bundlePath, 'checkpoint', checkpoint.name),
    highNoisePath: highNoise ? join(bundlePath, 'checkpoint', highNoise.name) : undefined,
    weights,
    defaults: info.manifest?.defaults ?? {},
    extraArgs: info.manifest?.extra_args ?? [],
    loraDir: loras.length > 0 ? join(bundlePath, 'lora') : undefined,
    capabilities,
    s2v: capabilities.includes('s2v') ? resolveS2vConfig(info.manifest) : undefined,
  };
}

/** Absolute path to a component file inside a bundle. */
export function componentPath(bundlePath: string, slot: ComponentSlot, name: string): string {
  return safeResolve(join(bundlePath, slotDirName(slot)), name);
}
