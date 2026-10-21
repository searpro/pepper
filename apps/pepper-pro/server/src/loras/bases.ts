/**
 * The base models a LoRA can be made for. A LoRA patches the weights of one
 * architecture, so it fits every recipe built on that model and no other: a
 * Qwen-Image 2.1 LoRA works with its base edit and both Turbo recipes, and
 * would fail to load (or quietly do nothing) on Krea 2. A recipe names its
 * base in `lora_base`; a LoRA in the library names the same id.
 *
 * `hints` recognise a base in what a source says about a file (Civitai's
 * `baseModel`, a HuggingFace card's `base_model`, the file name), so adding a
 * LoRA can propose one. It is only a proposal: sources name bases loosely,
 * and the person adding the LoRA confirms it.
 */

export interface LoraBase {
  id: string;
  label: string;
  hints: RegExp[];
}

export const LORA_BASES = [
  // Civitai calls it "Qwen 2.1"; HuggingFace cards name the repository.
  { id: 'qwen-image-2.1', label: 'Qwen-Image 2.1', hints: [/qwen[\s._-]*image[\s._-]*2\.?1/i, /^qwen[\s._-]*2\.1$/i] },
  { id: 'krea-2', label: 'Krea 2', hints: [/krea[\s._-]*2/i] },
  { id: 'z-image', label: 'Z-Image (Turbo)', hints: [/z[\s._-]*image/i] },
  { id: 'flux2-klein-4b', label: 'FLUX.2 klein 4B', hints: [/flux[\s._-]*\.?2.*klein.*4\s*b/i, /klein[\s._-]*4b/i] },
  { id: 'minimax-h3', label: 'MiniMax H3', hints: [/minimax[\s._-]*h3/i] },
  // Civitai: "LTXV 2.5" (and "LTXV 2.3", a different model, left unmatched).
  { id: 'ltx-2.5', label: 'LTX-2.5 (22B)', hints: [/ltxv?[\s._-]*(video[\s._-]*)?2\.5/i, /ltxv?[\s._-]*2[\s._-]*22b/i] },
  // Civitai names Wan 2.1 by size alone ("Wan Video 14B i2v 480p"); 2.2's two-expert models say "2.2".
  {
    id: 'wan-2.1-14b',
    label: 'Wan 2.1 14B',
    hints: [/wan[\s._-]*(video[\s._-]*)?2\.1[^\d]*14\s*b/i, /wan[\s._-]*(video[\s._-]*)?2\.1/i, /^wan[\s._-]*video[\s._-]*14b[\s._-]*(t2v|i2v)/i],
  },
  // Civitai has no YuE2 base yet; HuggingFace cards and trainer outputs name it.
  { id: 'yue2', label: 'YuE2 3B', hints: [/yue[\s._-]*2/i] },
] as const satisfies readonly LoraBase[];

export const LORA_BASE_IDS = LORA_BASES.map((base) => base.id) as [LoraBaseId, ...LoraBaseId[]];
export type LoraBaseId = (typeof LORA_BASES)[number]['id'];

/** The first base any of `texts` names, in the table's order. */
export function guessBase(...texts: (string | undefined)[]): LoraBaseId | undefined {
  for (const base of LORA_BASES) {
    if (texts.some((text) => text && base.hints.some((hint) => hint.test(text)))) return base.id;
  }
  return undefined;
}

export function baseLabel(id: string): string {
  return LORA_BASES.find((base) => base.id === id)?.label ?? id;
}
