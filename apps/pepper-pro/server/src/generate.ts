import { copyFile, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { errors } from '@pepper/core/errors.js';
import { safeResolve } from '@pepper/core/paths.js';
import { uniqueOutputName } from '@pepper/core/util/files.js';
import { sizeFor } from './projects/derive.js';
import type { Recipe, RecipeParam } from './recipes/schema.js';
import type { RecipeStatus } from './recipes/store.js';

/**
 * Generation the way hosted tools offer it (Higgsfield, fal, Replicate): pick
 * a model, give a prompt, an aspect ratio, a duration and media by URL, get a
 * job back. Recipes keep their own parameter names (recipes/README.md); this
 * maps one generic request onto whichever recipe runs it, and describes each
 * recipe in the same generic terms, so a caller never needs to know that H3
 * calls its start frame `first_frame` and InfiniteTalk calls it `image`.
 */

export const GENERIC_MEDIA = ['image', 'end_image', 'reference_images', 'audio', 'audio_2', 'video', 'voice_reference'] as const;
export type GenericMedia = (typeof GENERIC_MEDIA)[number];
export type GenerateKind = 'image' | 'video' | 'audio';

export interface GenericRequest {
  prompt?: string;
  image?: string;
  end_image?: string;
  reference_images?: string[];
  audio?: string;
  audio_2?: string;
  video?: string;
  voice_reference?: string;
  /** A preset voice name, or a description of a voice to design. */
  voice?: string;
  lyrics?: string;
  duration?: number;
  aspect_ratio?: string;
  /** `draft` or `final`, or any mode the recipe has. */
  quality?: string;
  seed?: number;
  /** Recipe parameters by their own names, for anything the generic fields do not cover. */
  params?: Record<string, unknown>;
}

/** For each generic field, the recipe parameters it fills, first match wins. */
const TARGETS: Record<string, { names: string[]; types: RecipeParam['type'][] }> = {
  prompt: { names: ['prompt', 'text'], types: ['text', 'string'] },
  image: { names: ['first_frame', 'image', 'images'], types: ['image', 'images'] },
  end_image: { names: ['last_frame'], types: ['image'] },
  reference_images: { names: ['refs', 'reference_images', 'images', 'reference'], types: ['images', 'image'] },
  audio: { names: ['audio'], types: ['audio'] },
  audio_2: { names: ['audio_2'], types: ['audio'] },
  video: { names: ['video'], types: ['video'] },
  voice_reference: { names: ['voice_ref', 'voice_refs'], types: ['audio', 'audios'] },
  voice: { names: ['speaker', 'voice'], types: ['enum', 'text', 'string'] },
  lyrics: { names: ['lyrics'], types: ['text', 'string'] },
  duration: { names: ['duration', 'seconds'], types: ['float', 'int'] },
};

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9'] as const;

function target(recipe: Recipe, field: string): RecipeParam | undefined {
  const spec = TARGETS[field];
  for (const name of spec.names) {
    const param = recipe.params.find((p) => p.name === name && spec.types.includes(p.type));
    if (param) return param;
  }
  return undefined;
}

/** What a recipe takes, in generic terms: what list_models shows and what the request is checked against. */
export interface ModelDescription {
  id: string;
  name: string;
  kind: Recipe['kind'];
  description: string;
  capabilities: string[];
  installed: boolean;
  /** Set when the model cannot run here: not installed, or barred by the licence mode. */
  unavailable?: string;
  /** Generic inputs it accepts: `required` or `optional`. */
  inputs: Record<string, 'required' | 'optional'>;
  max_reference_images?: number;
  duration?: { min?: number; max?: number; default?: unknown };
  aspect_ratios?: readonly string[];
  qualities: string[];
  default_quality: string;
  /** Measured on a GPU: when, where, and seconds per output of the golden shots. */
  verified?: { date: string; gpu: string; seconds?: number };
  licence: { name: string; commercial: string };
  install_bytes: number;
}

export function describeModel(recipe: Recipe, status: RecipeStatus): ModelDescription {
  const inputs: Record<string, 'required' | 'optional'> = {};
  for (const field of Object.keys(TARGETS)) {
    if (field === 'duration') continue;
    const param = target(recipe, field);
    if (!param) continue;
    // `images` serves both the edited image and its references (Qwen-Image-Edit):
    // required as a list, it means the image is required and references optional.
    const required = param.required && !(field === 'reference_images' && param.name === 'images');
    inputs[field] = required ? 'required' : 'optional';
  }
  const refs = target(recipe, 'reference_images');
  const duration = target(recipe, 'duration');
  const sized = recipe.params.some((p) => p.name === 'width') && recipe.params.some((p) => p.name === 'height');
  const unavailable =
    status.licenceBlock ?? (status.state !== 'installed' ? `not installed (install_model "${recipe.id}" first)` : undefined);
  return {
    id: recipe.id,
    name: recipe.name,
    kind: recipe.kind,
    description: recipe.description,
    capabilities: recipe.capabilities,
    installed: status.state === 'installed',
    unavailable,
    inputs,
    max_reference_images: refs ? (refs.type === 'image' ? 1 : refs.max_items) : undefined,
    duration: duration ? { min: duration.min, max: duration.max, default: duration.default } : undefined,
    aspect_ratios: sized ? ASPECT_RATIOS : undefined,
    qualities: Object.keys(recipe.modes),
    default_quality: recipe.default_mode,
    verified: recipe.verified ? { date: recipe.verified.date, gpu: recipe.verified.gpu, seconds: recipe.verified.seconds } : undefined,
    licence: { name: recipe.licence.name, commercial: recipe.licence.commercial },
    install_bytes: status.installBytes,
  };
}

/** The generic fields a request sets, besides the prompt and settings every model takes. */
function givenInputs(request: GenericRequest): string[] {
  const fields: string[] = [];
  for (const field of [...GENERIC_MEDIA, 'voice', 'lyrics'] as const) {
    const value = request[field];
    if (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '') fields.push(field);
  }
  return fields;
}

/** Why a model cannot take this request, or null if it can. */
export function mismatch(model: ModelDescription, request: GenericRequest): string | null {
  if (model.unavailable) return model.unavailable;
  for (const field of givenInputs(request)) {
    if (!model.inputs[field]) return `does not take ${field}`;
  }
  for (const [field, need] of Object.entries(model.inputs)) {
    if (need !== 'required') continue;
    const value = field === 'image' ? (request.image ?? request.reference_images?.[0]) : request[field as keyof GenericRequest];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return `needs ${field}`;
  }
  if (model.inputs.prompt === 'required' && !request.prompt?.trim()) return 'needs a prompt';
  return null;
}

/**
 * The model a request runs on when it names none: of those installed that
 * can take every input given, a verified one first, then the order below,
 * which puts the best general model of each kind first.
 */
const PREFERENCE: Record<string, string[]> = {
  video: ['h3-video', 'h3-reference', 'ltx25-video', 'infinitetalk', 'infinitetalk-duo', 'longcat-avatar', 'ltx23-audio-to-video', 'wan-animate2', 'scail2-replace', 'wan-dancer', 'seedvr2-upscale-video'],
  image: ['krea2-image', 'zimage-turbo', 'flux2-klein-edit', 'qwen-image-edit', 'seedvr2-upscale-image'],
  audio: ['qwen3-tts', 'ace-step-music', 'minimax-music-3'],
};

export function pickModel(
  kind: GenerateKind,
  request: GenericRequest,
  models: ModelDescription[],
  audioType?: 'speech' | 'music',
): ModelDescription {
  const order = PREFERENCE[kind] ?? [];
  const rank = (m: ModelDescription) => (m.verified ? 0 : 100) + (order.includes(m.id) ? order.indexOf(m.id) : 50);
  const ofKind = models
    .filter((m) => m.kind === kind)
    .filter((m) => !audioType || m.capabilities.includes(audioType));
  const fits = ofKind.filter((m) => !mismatch(m, request)).sort((a, b) => rank(a) - rank(b));
  if (fits[0]) return fits[0];
  const reasons = ofKind.map((m) => `${m.id}: ${mismatch(m, request)}`).join('; ');
  throw errors.validation(`No ${audioType ?? kind} model here can take this request (${reasons || 'none installed'})`);
}

/** A recipe's parameters for a generic request: mode, values by the recipe's own names. */
export function mapRequest(recipe: Recipe, request: GenericRequest): { mode: string; params: Record<string, unknown> } {
  const mode = chooseMode(recipe, request);
  const params: Record<string, unknown> = {};
  const set = (field: string, value: unknown) => {
    const param = target(recipe, field);
    if (!param || value === undefined) return;
    if (param.type === 'images' || param.type === 'audios') {
      const list = (Array.isArray(value) ? value : [value]) as string[];
      const existing = (params[param.name] as string[] | undefined) ?? [];
      params[param.name] = [...existing, ...list].slice(0, param.max_items ?? undefined);
    } else {
      params[param.name] = Array.isArray(value) ? value[0] : value;
    }
  };

  set('prompt', request.prompt);
  set('image', request.image);
  // A recipe with one image input and no reference input (an image-to-video
  // model) takes the first reference as its start frame.
  if (!request.image && request.reference_images?.length && !target(recipe, 'reference_images') && target(recipe, 'image')) {
    set('image', request.reference_images[0]);
  } else {
    set('reference_images', request.reference_images);
  }
  set('end_image', request.end_image);
  set('audio', request.audio);
  set('audio_2', request.audio_2);
  set('video', request.video);
  set('voice_reference', request.voice_reference);
  set('lyrics', request.lyrics);
  if (request.voice) {
    const speaker = recipe.params.find((p) => p.name === 'speaker' && p.type === 'enum');
    const preset = speaker?.options?.find((o) => String(o).toLowerCase() === request.voice!.toLowerCase());
    if (preset !== undefined) params.speaker = preset;
    else if (recipe.params.some((p) => p.name === 'voice')) params.voice = request.voice;
    else throw errors.validation(`${recipe.name} has no voice "${request.voice}"${speaker?.options ? ` (${speaker.options.join(', ')})` : ''}`);
  }

  if (request.duration !== undefined) {
    const param = target(recipe, 'duration');
    if (!param) throw errors.validation(`${recipe.name} sets its own length; leave duration out`);
    if ((param.min !== undefined && request.duration < param.min) || (param.max !== undefined && request.duration > param.max)) {
      throw errors.validation(
        `${recipe.name} renders ${param.min ?? 0}-${param.max} s at once` +
          (recipe.continuation ? '; for longer, make it a project shot (render_shots chains it)' : ''),
      );
    }
    params[param.name] = param.type === 'int' ? Math.round(request.duration) : request.duration;
  }

  if (request.aspect_ratio) {
    const width = recipe.params.find((p) => p.name === 'width');
    const height = recipe.params.find((p) => p.name === 'height');
    if (!width || !height) throw errors.validation(`${recipe.name} takes its size from its input; leave aspect_ratio out`);
    const defaults = recipe.modes[mode]?.defaults ?? {};
    const w = (defaults.width ?? width.default) as number;
    const h = (defaults.height ?? height.default) as number;
    Object.assign(params, sizeFor(request.aspect_ratio, w, h));
  }
  if (request.seed !== undefined) params.seed = request.seed;
  return { mode, params: { ...params, ...(request.params ?? {}) } };
}

/**
 * `quality` names a mode; without it, a speech recipe's mode follows from how
 * the voice was given (a clip to clone, a preset name, a description), and
 * anything else uses the recipe's default.
 */
function chooseMode(recipe: Recipe, request: GenericRequest): string {
  if (request.quality) {
    if (recipe.modes[request.quality]) return request.quality;
    throw errors.validation(`${recipe.name} has no quality "${request.quality}" (${Object.keys(recipe.modes).join(', ')})`);
  }
  if (recipe.capabilities.includes('speech')) {
    const speaker = recipe.params.find((p) => p.name === 'speaker');
    const isPreset = request.voice && speaker?.options?.some((o) => String(o).toLowerCase() === request.voice!.toLowerCase());
    if (request.voice_reference && recipe.modes.final) return 'final';
    if (isPreset && recipe.modes.preset) return 'preset';
    if (request.voice && recipe.modes.design) return 'design';
  }
  return recipe.default_mode;
}

const MAX_FETCH_BYTES = 500 * 1024 * 1024;
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/**
 * One media input as an upload name the recipe can read: a URL is fetched,
 * a `data:` URI decoded, a previous output copied in; an existing upload name
 * is used as it is. So a caller can hand over whatever it has.
 */
export async function resolveMedia(value: string, dirs: { uploadsDir: string; outputDir: string }): Promise<string> {
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'pepper-pro' } });
    if (!response.ok) throw errors.validation(`Could not fetch ${value}: HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_FETCH_BYTES) throw errors.validation(`${value} is larger than 500 MB`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_FETCH_BYTES) throw errors.validation(`${value} is larger than 500 MB`);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const ext = extname(new URL(value).pathname).replace(/^\./, '').toLowerCase() || EXT_BY_TYPE[type];
    if (!ext) throw errors.validation(`Cannot tell what kind of file ${value} is (content-type "${type}")`);
    const name = uniqueOutputName(ext, 'upload');
    await writeFile(safeResolve(dirs.uploadsDir, name), data);
    return name;
  }
  const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (dataUri) {
    const ext = EXT_BY_TYPE[dataUri[1].toLowerCase()];
    if (!ext) throw errors.validation(`Unsupported data URI type ${dataUri[1]}`);
    const name = uniqueOutputName(ext, 'upload');
    await writeFile(safeResolve(dirs.uploadsDir, name), Buffer.from(dataUri[2], 'base64'));
    return name;
  }
  // A signed or plain link to one of our own outputs or uploads, by its last segment.
  const bare = decodeURIComponent(value.split('?')[0].split('/').pop() ?? value);
  if (await exists(safeResolve(dirs.uploadsDir, bare))) return bare;
  if (await exists(safeResolve(dirs.outputDir, bare))) {
    const name = uniqueOutputName(extname(bare).replace(/^\./, '') || 'bin', 'upload');
    await copyFile(safeResolve(dirs.outputDir, bare), safeResolve(dirs.uploadsDir, name));
    return name;
  }
  throw errors.validation(`"${value}" is not a URL, a data URI, an upload or an output name`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every media field of a request, resolved to upload names. */
export async function resolveRequestMedia(
  request: GenericRequest,
  dirs: { uploadsDir: string; outputDir: string },
): Promise<GenericRequest> {
  const out: GenericRequest = { ...request };
  for (const field of GENERIC_MEDIA) {
    const value = request[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) out.reference_images = await Promise.all(value.map((v) => resolveMedia(v, dirs)));
    else (out as Record<string, unknown>)[field] = await resolveMedia(value, dirs);
  }
  return out;
}
