import type { Recipe, RecipeParam } from '../recipes/schema.js';
import type { AssetRow, ProjectRow, ShotRow } from './schema.js';

/**
 * From a shot to a recipe's parameters.
 *
 * A shot is written in the director's terms — who is in it, what they say,
 * the framing, the sound, a first and last frame — and a recipe takes the
 * model's terms. The mapping is by parameter *name*, a convention every
 * recipe follows (recipes/README.md), so a new recipe needs no code here:
 *
 *   prompt                      the composed prompt (below)
 *   image, first_frame          the shot's first keyframe (or its first reference)
 *   last_frame                  the last keyframe
 *   refs, reference_images      the images of the assets in the shot, in order
 *   audio                       the shot's driving audio asset
 *   voice_refs                  the voice clips of the speakers, in speaking order
 *   duration, seconds           the shot's length
 *   aspect                      the project's aspect ratio
 *   width, height               the aspect at the recipe's default pixel count
 *   fps                         the project's frame rate
 *
 * Only parameters the recipe declares are set, and the shot's own `params`
 * override everything derived.
 */

export interface DeriveInput {
  project: ProjectRow;
  shot: ShotRow;
  /** The shot's assets, in `assetIds` order, plus any dialogue speakers. */
  assets: AssetRow[];
  recipe: Recipe;
}

interface DialogueLine {
  asset_id?: string;
  speaker?: string;
  line: string;
}

const ASPECT_RATIOS: Record<string, number> = {
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '21:9': 21 / 9,
};

function round32(value: number): number {
  return Math.max(32, Math.round(value / 32) * 32);
}

/** Width and height for an aspect at the same pixel count as a recipe's defaults. */
export function sizeFor(aspect: string, defaultWidth: number, defaultHeight: number): { width: number; height: number } {
  const ratio = ASPECT_RATIOS[aspect] ?? defaultWidth / defaultHeight;
  const area = defaultWidth * defaultHeight;
  return { width: round32(Math.sqrt(area * ratio)), height: round32(Math.sqrt(area / ratio)) };
}

/**
 * The prompt for a shot. Recipes whose model binds references by tag (H3's
 * `<Picture n>` / `<Subject n>`, capability `subject-tags`) get the assets
 * introduced with their tags, so "<Subject 1> says exactly this" refers to a
 * person the model can see; others get plain descriptions.
 */
export function composePrompt(input: DeriveInput): string {
  const { project, shot, assets, recipe } = input;
  const tags = recipe.capabilities.includes('subject-tags');
  const inShot = (shot.assetIds as string[]).map((id) => assets.find((a) => a.id === id)).filter(Boolean) as AssetRow[];
  const subject = new Map<string, string>();
  const lines: string[] = [];

  if (project.style.trim()) lines.push(project.style.trim());

  let picture = 0;
  inShot.forEach((asset, index) => {
    const images = asset.images as string[];
    const label = tags ? `<Subject ${index + 1}>` : asset.name;
    subject.set(asset.id, label);
    const pictureTag = tags && images.length > 0 ? ` (<Picture ${picture + 1}>)` : '';
    picture += images.length;
    if (asset.description.trim() || tags) {
      lines.push(`${tags ? `${label} is ${asset.name}${pictureTag}` : asset.name}: ${asset.description.trim()}`.trim());
    }
  });

  const direction = [shot.framing.trim(), shot.camera.trim()].filter(Boolean).join(', ');
  lines.push([direction ? `${direction}.` : '', shot.prompt.trim()].filter(Boolean).join(' '));

  for (const entry of shot.dialogue as DialogueLine[]) {
    if (!entry.line?.trim()) continue;
    const speaker =
      (entry.asset_id && subject.get(entry.asset_id)) ??
      (entry.asset_id ? assets.find((a) => a.id === entry.asset_id)?.name : undefined) ??
      entry.speaker ??
      'The speaker';
    const line = entry.line.trim().replace(/"/g, "'");
    // A closing full stop tells the model where the line ends.
    lines.push(`${speaker} says exactly this: "${/[.!?…]$/.test(line) ? line : `${line}.`}"`);
  }

  if (shot.sound.trim()) lines.push(`Sound: ${shot.sound.trim()}`);
  return lines.filter(Boolean).join('\n');
}

function has(recipe: Recipe, name: string, types?: RecipeParam['type'][]): RecipeParam | undefined {
  const param = recipe.params.find((p) => p.name === name);
  return param && (!types || types.includes(param.type)) ? param : undefined;
}

export function deriveParams(input: DeriveInput): Record<string, unknown> {
  const { project, shot, assets, recipe } = input;
  const out: Record<string, unknown> = {};
  const keyframes = shot.keyframes as { first?: string; last?: string };
  const inShot = (shot.assetIds as string[]).map((id) => assets.find((a) => a.id === id)).filter(Boolean) as AssetRow[];
  const images = inShot.flatMap((a) => a.images as string[]);

  if (has(recipe, 'prompt')) out.prompt = composePrompt(input);

  const first = keyframes.first ?? (has(recipe, 'refs', ['images']) || has(recipe, 'reference_images', ['images']) ? undefined : images[0]);
  if (first && has(recipe, 'first_frame', ['image'])) out.first_frame = first;
  if (first && has(recipe, 'image', ['image'])) out.image = first;
  if (keyframes.last && has(recipe, 'last_frame', ['image'])) out.last_frame = keyframes.last;

  for (const name of ['refs', 'reference_images']) {
    const param = has(recipe, name, ['images']);
    if (param && images.length > 0) out[name] = images.slice(0, param.max_items ?? images.length);
  }

  if (shot.audioAssetId && has(recipe, 'audio', ['audio'])) {
    const audio = assets.find((a) => a.id === shot.audioAssetId)?.audio;
    if (audio) out.audio = audio;
  }

  const voices = has(recipe, 'voice_refs', ['audios']);
  if (voices) {
    const clips: string[] = [];
    for (const entry of shot.dialogue as DialogueLine[]) {
      const clip = (assets.find((a) => a.id === entry.asset_id)?.voice as { upload?: string } | null)?.upload;
      if (clip && !clips.includes(clip)) clips.push(clip);
    }
    if (clips.length > 0) out.voice_refs = clips.slice(0, voices.max_items ?? clips.length);
  }

  for (const name of ['duration', 'seconds']) {
    const param = has(recipe, name, ['int', 'float']);
    if (!param) continue;
    let value = shot.durationS;
    if (param.min !== undefined) value = Math.max(param.min, value);
    if (param.max !== undefined) value = Math.min(param.max, value);
    out[name] = param.type === 'int' ? Math.round(value) : value;
  }

  const aspect = has(recipe, 'aspect', ['enum']);
  if (aspect?.options?.includes(project.aspect)) out.aspect = project.aspect;

  const width = has(recipe, 'width', ['int']);
  const height = has(recipe, 'height', ['int']);
  if (width && height && typeof width.default === 'number' && typeof height.default === 'number') {
    Object.assign(out, sizeFor(project.aspect, width.default, height.default));
  }
  if (has(recipe, 'fps', ['int', 'float'])) out.fps = project.fps;

  return { ...out, ...(shot.params as Record<string, unknown>) };
}
