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
 *   width, height               the aspect at the mode's (or recipe's) default pixel count
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
  /** The mode the take renders in; a draft mode's smaller default size sets the pixel count. */
  mode?: string;
  /**
   * The take continues earlier footage (a long take's later segment, or a
   * shot that carries on from the one before): it opens on that footage, so
   * it gets no opening frame and its prompt says it carries on.
   */
  continuing?: boolean;
}

interface DialogueLine {
  asset_id?: string;
  speaker?: string;
  line: string;
  /** The spoken language, for H3's `<d>[Language]` tag; English when absent. */
  language?: string;
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
  if (recipe.prompt_format) return composeH3Prompt(input, recipe.prompt_format);
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

function shotAssets(shot: ShotRow, assets: AssetRow[]): AssetRow[] {
  return (shot.assetIds as string[]).map((id) => assets.find((a) => a.id === id)).filter(Boolean) as AssetRow[];
}

/**
 * The first and last frames a shot hands the recipe: its keyframes, else
 * (for a recipe with no reference input) its first asset's first image as
 * the opening frame. One function, because the prompt has to say exactly
 * which pictures the model was given.
 */
function framesFor(input: DeriveInput): { first?: string; last?: string } {
  const { shot, assets, recipe } = input;
  const keyframes = shot.keyframes as { first?: string; last?: string };
  const images = shotAssets(shot, assets).flatMap((a) => a.images as string[]);
  const takesRefs = Boolean(has(recipe, 'refs', ['images']) || has(recipe, 'reference_images', ['images']));
  const first = input.continuing ? undefined : (keyframes.first ?? (takesRefs ? undefined : images[0]));
  const takesFirst = Boolean(has(recipe, 'first_frame', ['image']) || has(recipe, 'image', ['image']));
  return {
    first: first && takesFirst ? first : undefined,
    last: keyframes.last && has(recipe, 'last_frame', ['image']) ? keyframes.last : undefined,
  };
}

/** The shot's length as the recipe will render it. */
function durationFor(recipe: Recipe, seconds: number): number {
  for (const name of ['duration', 'seconds']) {
    const param = has(recipe, name, ['int', 'float']);
    if (!param) continue;
    let value = seconds;
    if (param.min !== undefined) value = Math.max(param.min, value);
    if (param.max !== undefined) value = Math.min(param.max, value);
    return param.type === 'int' ? Math.round(value) : value;
  }
  return seconds;
}

/** The voice clips of a shot's speakers, in speaking order, as `voice_refs` takes them. */
function voiceClips(shot: ShotRow, assets: AssetRow[], max?: number): { clip: string; assetId: string }[] {
  const out: { clip: string; assetId: string }[] = [];
  for (const entry of shot.dialogue as DialogueLine[]) {
    const clip = (assets.find((a) => a.id === entry.asset_id)?.voice as { upload?: string } | null)?.upload;
    if (clip && entry.asset_id && !out.some((c) => c.clip === clip)) out.push({ clip, assetId: entry.asset_id });
  }
  return out.slice(0, max ?? out.length);
}

// --- H3 -----------------------------------------------------------------------

/** A prompt already written in one of H3's formats, by Claude or a local model, passes through. */
const H3_STRUCTURED = /^\s*(integrated_multimodal_description|subject_definitions|detailed_description)\s*:|^\s*(For the target video|How the reference pictures align)/m;

/** `sound` holds ambience and effects, then optionally `Music: …` for the score the characters cannot hear. */
function splitSound(sound: string): { soundscape: string; music: string } {
  const at = sound.search(/\bmusic\s*:/i);
  if (at < 0) return { soundscape: sound.trim(), music: '' };
  return { soundscape: sound.slice(0, at).trim().replace(/[\s.;,]+$/, ''), music: sound.slice(at).replace(/^music\s*:\s*/i, '').trim() };
}

function sentence(text: string): string {
  const t = text.trim();
  return !t ? '' : /[.!?…]["')\]]?$/.test(t) ? t : `${t}.`;
}

/** A field's prose starts with a capital, as MiniMax's examples do. */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ref2VA's shots refer to people by label, not by name: "<Subject 1> stands at the bus stop". */
function labelNames(text: string, subjects: Iterable<{ label: string; asset: AssetRow }>): string {
  let out = text;
  for (const { label, asset } of subjects) {
    if (!asset.name.trim()) continue;
    const name = asset.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w<])${name}(?![\\w>])`, 'g'), label);
  }
  return out;
}

/** Camera direction as a sentence: written as one, it stays; a bare move ("slow push-in") is labelled. */
function cameraSentence(camera: string): string {
  const c = camera.trim();
  if (!c) return '';
  return /^the (camera|shot)\b/i.test(c) ? sentence(c) : `Camera: ${sentence(c)}`;
}

/** The highest `[Shot N]` the director wrote, so a last frame lands in the final shot. */
function lastShotNumber(text: string): number {
  let max = 1;
  for (const m of text.matchAll(/\[Shot (\d+)\]/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/**
 * A shot in H3's own prompt format (MiniMax-H3 docs: VIDEO_PROMPT_WRITING_GUIDE
 * base and ref). H3 was trained on these structures, and the field reports agree
 * that following them matters more than steps or samplers: a shot with no
 * timeline coverage loses its subject late in the clip, and speech outside
 * `<d>` blocks loses its words.
 *
 * - `h3-base` (FL2VA: text, first, last frame): the frame-alignment line, then
 *   `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music`.
 * - `h3-reference` (Ref2VA): `subject_definitions`, `summary`,
 *   `retention_analysis`, `detailed_description` and the two sound fields,
 *   with every reference image and voice clip bound to its label.
 *
 * Speakers get stable `(S1)`, `(S2)` IDs in the order they first speak, and
 * their lines go into `<d>[Language] …</d>` verbatim.
 */
export function composeH3Prompt(input: DeriveInput, format: 'h3-base' | 'h3-reference'): string {
  const { project, shot, assets, recipe } = input;
  const written = shot.prompt.trim();
  if (H3_STRUCTURED.test(written)) return written;

  const inShot = shotAssets(shot, assets);
  const style = project.style.trim() || 'Live-action, cinematic';
  const { soundscape, music } = splitSound(shot.sound);
  const reference = format === 'h3-reference';

  // Labels: Ref2VA binds each asset to a <Subject n> and each image to a <Picture n>, in the order deriveParams passes them.
  const refsParam = has(recipe, 'refs', ['images']) ?? has(recipe, 'reference_images', ['images']);
  let pictureBudget = refsParam?.max_items ?? Infinity;
  let picture = 0;
  const subjects = new Map<string, { label: string; pictures: string[]; asset: AssetRow }>();
  inShot.forEach((asset, index) => {
    const pictures: string[] = [];
    for (const _ of asset.images as string[]) {
      if (pictureBudget <= 0) break;
      pictureBudget -= 1;
      picture += 1;
      pictures.push(`<Picture ${picture}>`);
    }
    subjects.set(asset.id, { label: reference ? `<Subject ${index + 1}>` : asset.name, pictures, asset });
  });

  const speakers = new Map<string, string>();
  const speakerKey = (entry: DialogueLine) => entry.asset_id ?? entry.speaker ?? 'speaker';
  for (const entry of shot.dialogue as DialogueLine[]) {
    if (entry.line?.trim() && !speakers.has(speakerKey(entry))) speakers.set(speakerKey(entry), `S${speakers.size + 1}`);
  }
  const voiceOf = (assetId?: string) => {
    const voice = assets.find((a) => a.id === assetId)?.voice as { description?: string } | null;
    return voice?.description?.trim() ?? '';
  };

  const lines = (shot.dialogue as DialogueLine[])
    .filter((entry) => entry.line?.trim())
    .map((entry) => {
      const id = speakers.get(speakerKey(entry))!;
      const subject = entry.asset_id ? subjects.get(entry.asset_id) : undefined;
      const name =
        subject?.label ?? (entry.asset_id ? assets.find((a) => a.id === entry.asset_id)?.name : undefined) ?? entry.speaker ?? 'The speaker';
      // The guide's form: "The young woman with a quiet, breathy voice (S1) says: <d>…</d>".
      const voice = voiceOf(entry.asset_id).replace(/^with\s+/i, '');
      return `${name}${voice ? ` with ${voice}` : ''} (${id}) says: <d>[${entry.language?.trim() || 'English'}] ${entry.line.trim()}</d>`;
    });

  const describe = (asset: AssetRow) => asset.description.trim().replace(/[.\s]+$/, '');
  const direction = [shot.framing.trim() ? sentence(shot.framing) : '', cameraSentence(shot.camera)].filter(Boolean).join(' ');
  const action = written.replace(/^\s*\[Shot 1\]\s*/, '');
  const soundField = soundscape ? capital(sentence(soundscape)) : 'The natural ambience of the scene continues throughout, with the sounds of the action as it happens.';
  const musicField = music ? capital(sentence(music)) : 'N/A';

  if (!reference) {
    const { first, last } = framesFor(input);
    const seconds = durationFor(recipe, shot.durationS).toFixed(2);
    const cast = inShot.filter((a) => describe(a)).map((a) => `${a.name}: ${describe(a)}.`);
    const opening = first
      ? ['The scene begins exactly as shown in <Picture 1>, preserving its subjects, appearance, clothing and setting.']
      : input.continuing
        ? ['The shot carries straight on from the footage before it, keeping the same subjects, clothing, setting, light and camera position.']
        : [];
    const body = [`[Shot 1] ${sentence(style)}`, ...opening, ...cast, direction, sentence(action), ...lines]
      .filter(Boolean)
      .join(' ');
    const shotsN = lastShotNumber(body);
    const ending = last ? ` By the end of [Shot ${shotsN}], the shot settles into the composition, poses and lighting established by <Picture ${first ? 2 : 1}>.` : '';
    const instruction = first && last
      ? `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${shotsN}) aligns with the ${seconds}-second mark of the target video.`
      : first
        ? 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
        : last
          ? `How the reference pictures align with the target video — <Picture 1> (from [Shot ${shotsN}]) aligns with the ${seconds}-second mark of the target video.`
          : '';
    return [
      ...(instruction ? [instruction, ''] : []),
      `integrated_multimodal_description: ${body}${ending}`,
      '',
      `overall_soundscape: ${soundField}`,
      '',
      `non_diegetic_music: ${musicField}`,
    ].join('\n');
  }

  const voices = voiceClips(shot, assets, has(recipe, 'voice_refs', ['audios'])?.max_items);
  const definitions = [...subjects.values()].map(({ label, pictures, asset }) => {
    const source = pictures.length ? ` in ${pictures.join(', ')}` : '';
    const what = describe(asset);
    return `${label} is ${asset.name}${source}${what ? `, ${what.charAt(0).toLowerCase()}${what.slice(1)}` : ''}.`;
  });
  voices.forEach(({ assetId }, i) => {
    const subject = subjects.get(assetId)?.label ?? assets.find((a) => a.id === assetId)?.name ?? 'the speaker';
    definitions.push(`<Audio ${i + 1}> is the voice-timbre reference for ${subject} (${speakers.get(assetId) ?? 'S1'}).`);
  });
  const named = [...subjects.values()].map((s) => s.label);
  const task = voices.length ? '[reference generation + audio reference]' : '[reference generation]';
  const labelled = labelNames(action, subjects.values());
  const summary = `${task} The target video shows ${named.length ? named.join(' and ') : 'the scene'}: ${sentence(labelled) || 'one continuous shot'}`;
  const retention = [
    ...[...subjects.values()].map(
      ({ label, asset }) => `${label} (appears in [Shot 1]): fully_preserved - ${asset.name}'s identity, appearance and clothing are retained.`,
    ),
    ...voices.map(({ assetId }, i) => {
      const subject = subjects.get(assetId)?.label ?? 'the speaker';
      return `<Audio ${i + 1}>: reference - its vocal timbre guides the delivery of ${subject} (${speakers.get(assetId) ?? 'S1'}) without copying the original signal.`;
    }),
  ];
  const shotBody = [`[Shot 1]`, labelNames(direction, subjects.values()), sentence(labelled), ...lines].filter(Boolean).join(' ');
  return [
    'subject_definitions:',
    ...(definitions.length ? definitions : ['N/A']),
    '',
    'summary:',
    summary,
    '',
    'retention_analysis:',
    ...(retention.length ? retention : ['N/A']),
    '',
    'detailed_description:',
    sentence(style),
    shotBody,
    '',
    'overall_soundscape:',
    soundField,
    '',
    'non_diegetic_music:',
    musicField,
  ].join('\n');
}

export function deriveParams(input: DeriveInput): Record<string, unknown> {
  const { project, shot, assets, recipe } = input;
  const out: Record<string, unknown> = {};
  const images = shotAssets(shot, assets).flatMap((a) => a.images as string[]);

  if (has(recipe, 'prompt')) out.prompt = composePrompt(input);

  const { first, last } = framesFor(input);
  if (first && has(recipe, 'first_frame', ['image'])) out.first_frame = first;
  if (first && has(recipe, 'image', ['image'])) out.image = first;
  if (last) out.last_frame = last;

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
    const clips = voiceClips(shot, assets, voices.max_items).map((c) => c.clip);
    if (clips.length > 0) out.voice_refs = clips;
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
  const modeDefaults = recipe.modes?.[input.mode ?? recipe.default_mode]?.defaults ?? {};
  const defaultWidth = modeDefaults.width ?? width?.default;
  const defaultHeight = modeDefaults.height ?? height?.default;
  if (width && height && typeof defaultWidth === 'number' && typeof defaultHeight === 'number') {
    Object.assign(out, sizeFor(project.aspect, defaultWidth, defaultHeight));
  }
  if (has(recipe, 'fps', ['int', 'float'])) out.fps = project.fps;

  return { ...out, ...(shot.params as Record<string, unknown>) };
}
