import { inputUrl } from '@/lib/images';

/**
 * Character Studio types and the helpers the generation screens share: how a
 * character's description goes into a prompt, which of its images stands in
 * for it, and which audio-job fields its voice sets.
 */

export type CharacterImageRole = 'sheet' | 'portrait' | 'reference';

export interface CharacterImage {
  name: string;
  role: CharacterImageRole;
  addedAt: string;
  prompt?: string;
}

export interface CharacterVoice {
  model?: string;
  instructions?: string;
  voice?: string;
  voice_ref?: string;
  sample?: string;
  sample_text?: string;
}

export interface Character {
  id: string;
  name: string;
  brief: string;
  style: string;
  appearance: string;
  personality: string;
  images: CharacterImage[];
  thumbnail: string | null;
  voice: CharacterVoice | null;
  pending: { jobId: string; role: CharacterImageRole | 'voice_sample' }[];
  createdAt: string;
  updatedAt: string;
}

export interface CharacterDesign {
  name: string;
  style: string;
  appearance: string;
  personality: string;
  voice: string;
  source: 'llm' | 'template';
  model?: string;
}

export const ROLE_LABELS: Record<CharacterImageRole, string> = {
  sheet: 'Sheet',
  portrait: 'Portrait',
  reference: 'Reference',
};

export function thumbnailUrl(character: Character): string | undefined {
  return character.thumbnail ? inputUrl(character.thumbnail) : undefined;
}

/**
 * The image that best stands in for the character as a single frame: a
 * portrait (a start frame or edit reference wants one figure, not a sheet of
 * six), then the thumbnail, then anything.
 */
export function primaryImage(character: Character): string | undefined {
  return (
    character.images.find((image) => image.role === 'portrait')?.name ??
    character.thumbnail ??
    character.images[0]?.name
  );
}

export function sheetImage(character: Character): string | undefined {
  return character.images.find((image) => image.role === 'sheet')?.name;
}

/** Fold a character's fixed description into a scene prompt. */
export function withCharacter(prompt: string, character: Character | undefined): string {
  const scene = prompt.trim();
  const appearance = (character?.appearance || character?.brief || '').trim().replace(/\.+$/, '');
  if (!appearance) return scene;
  return scene ? `${appearance}. ${scene}` : appearance;
}

/** The speech-job fields a character's voice decides. */
export function voiceParams(voice: CharacterVoice | null | undefined): Record<string, string> {
  if (!voice?.model) return {};
  const params: Record<string, string> = { model: voice.model };
  if (voice.voice) params.voice = voice.voice;
  if (voice.voice_ref) params.voice_ref = voice.voice_ref;
  if (voice.instructions?.trim()) params.instructions = voice.instructions.trim();
  return params;
}

export function voiceSummary(voice: CharacterVoice | null | undefined): string {
  if (!voice?.model) return 'No voice set';
  if (voice.voice_ref) return `Cloned from ${voice.voice_ref}`;
  if (voice.voice) return `Speaker ${voice.voice}`;
  if (voice.instructions) return voice.instructions;
  return voice.model;
}
