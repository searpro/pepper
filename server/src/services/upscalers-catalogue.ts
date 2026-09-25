/**
 * Upscaler checkpoints worth offering, with where to get them.
 *
 * Picked for what runs well on the machines Pepper targets — an Apple Silicon
 * Mac with 16–32 GB of unified memory, or a single consumer GPU. Every entry was
 * loaded through spandrel on an M4 (MPS) and, where noted, through sd-cli's
 * ESRGAN mode. Timings are a 256×320 → 4× pass on that M4, warm.
 *
 * `sdcpp` marks the checkpoints stable-diffusion.cpp can load: its ESRGAN
 * graph is plain RRDBNet only, so the compact, SPAN, RCAN and DAT models (and
 * RealESRGAN x2plus, which pixel-unshuffles its input) need the Python engine.
 */

export interface UpscalerCatalogueEntry {
  id: string;
  /** File name on disk; also how an installed file is matched back to its entry. */
  file: string;
  url: string;
  label: string;
  description: string;
  /** Native scale of the network. */
  scale: 2 | 4;
  architecture: string;
  /** What it is best at, for the picker. */
  bestFor: 'general' | 'photo' | 'illustration' | 'fast';
  license: string;
  sizeBytes: number;
  /** Whether sd-cli's ESRGAN mode can load it. */
  sdcpp: boolean;
}

const HF = 'https://huggingface.co';
const GH = 'https://github.com/xinntao/Real-ESRGAN/releases/download';

export const UPSCALER_CATALOGUE: UpscalerCatalogueEntry[] = [
  {
    id: 'realesrgan-x4plus',
    file: 'RealESRGAN_x4plus.safetensors',
    url: `${HF}/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors`,
    label: 'RealESRGAN x4plus',
    description: 'The reference general-purpose model. Balanced, a little soft on fine texture. ~1.2 s.',
    scale: 4,
    architecture: 'ESRGAN (RRDBNet)',
    bestFor: 'general',
    license: 'BSD-3-Clause',
    sizeBytes: 66_857_836,
    sdcpp: true,
  },
  {
    id: 'ultrasharp-4x',
    file: '4x-UltraSharp.safetensors',
    url: `${HF}/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors`,
    label: '4x-UltraSharp',
    description:
      'The community favourite for generated images: crisp edges and recovered texture. ~0.9 s.',
    scale: 4,
    architecture: 'ESRGAN (RRDBNet)',
    bestFor: 'general',
    license: 'CC-BY-NC-SA-4.0',
    sizeBytes: 66_864_028,
    sdcpp: true,
  },
  {
    id: 'ultrasharp-v2-4x',
    file: '4x-UltraSharpV2.safetensors',
    url: `${HF}/Kim2091/UltraSharpV2/resolve/main/4x-UltraSharpV2.safetensors`,
    label: '4x-UltraSharp V2 (DAT)',
    description:
      'Transformer successor to UltraSharp — the highest quality here, and the slowest (~6 s, fp32 only).',
    scale: 4,
    architecture: 'DAT',
    bestFor: 'photo',
    license: 'CC-BY-NC-SA-4.0',
    sizeBytes: 139_792_588,
    sdcpp: false,
  },
  {
    id: 'nmkd-siax-4x',
    file: '4x_NMKD-Siax_200k.pth',
    url: `${HF}/gemasai/4x_NMKD-Siax_200k/resolve/main/4x_NMKD-Siax_200k.pth`,
    label: '4x NMKD Siax',
    description: 'Natural-looking detail for photographs and realistic renders; resists over-sharpening. ~1.4 s.',
    scale: 4,
    architecture: 'ESRGAN (RRDBNet)',
    bestFor: 'photo',
    license: 'WTFPL',
    sizeBytes: 66_957_746,
    sdcpp: true,
  },
  {
    id: 'clearreality-4x',
    file: '4x-ClearRealityV1.safetensors',
    url: `${HF}/Kim2091/ClearRealityV1/resolve/main/4x-ClearRealityV1.safetensors`,
    label: '4x ClearReality',
    description: 'Tiny SPAN model — near-instant (~0.05 s) with clean, realistic output. 4.5 MB.',
    scale: 4,
    architecture: 'SPAN',
    bestFor: 'fast',
    license: 'Apache-2.0',
    sizeBytes: 4_492_232,
    sdcpp: false,
  },
  {
    id: 'realesr-general-x4v3',
    file: 'realesr-general-x4v3.pth',
    url: `${HF}/jhj0517/realesr-general-x4v3/resolve/main/realesr-general-x4v3.pth`,
    label: 'RealESR general x4v3',
    description: 'Real-ESRGAN’s compact model: very fast, and good at cleaning noise and JPEG artefacts.',
    scale: 4,
    architecture: 'RealESRGAN Compact (SRVGGNet)',
    bestFor: 'fast',
    license: 'BSD-3-Clause',
    sizeBytes: 4_885_111,
    sdcpp: false,
  },
  {
    id: 'realesrgan-x4plus-anime',
    file: 'RealESRGAN_x4plus_anime_6B.pth',
    url: `${GH}/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth`,
    label: 'RealESRGAN x4plus anime',
    description: 'Tuned for anime, illustration and flat-shaded art: clean lines, no painterly smearing.',
    scale: 4,
    architecture: 'ESRGAN (RRDBNet, 6 blocks)',
    bestFor: 'illustration',
    license: 'BSD-3-Clause',
    sizeBytes: 17_938_799,
    sdcpp: true,
  },
  {
    id: 'realesrgan-x2plus',
    file: 'RealESRGAN_x2plus.pth',
    url: `${GH}/v0.2.1/RealESRGAN_x2plus.pth`,
    label: 'RealESRGAN x2plus',
    description: 'A native 2× pass — sharper and faster than running a 4× model and halving it.',
    scale: 2,
    architecture: 'ESRGAN (pixel-unshuffle)',
    bestFor: 'general',
    license: 'BSD-3-Clause',
    sizeBytes: 67_061_725,
    sdcpp: false,
  },
  {
    id: 'animesharp-v4-2x',
    file: '2x-AnimeSharpV4_RCAN.safetensors',
    url: `${HF}/Kim2091/2x-AnimeSharpV4/resolve/main/2x-AnimeSharpV4_RCAN.safetensors`,
    label: '2x AnimeSharp V4',
    description: 'Native 2× for anime and illustration, preserving line art. ~1.2 s, fp32 only.',
    scale: 2,
    architecture: 'RCAN',
    bestFor: 'illustration',
    license: 'CC-BY-NC-SA-4.0',
    sizeBytes: 31_053_198,
    sdcpp: false,
  },
];

/** File names sd-cli is known to load, beyond the catalogue's own `sdcpp` flags. */
const SDCPP_KNOWN = [/realesrgan_x4plus/i, /ultrasharp\.|ultrasharp$/i, /siax/i];

export function catalogueEntryFor(file: string): UpscalerCatalogueEntry | undefined {
  const lower = file.toLowerCase();
  return UPSCALER_CATALOGUE.find((entry) => entry.file.toLowerCase() === lower);
}

/** Whether sd-cli can be expected to load this file: from the catalogue, else by name. */
export function sdcppCompatible(file: string): boolean | undefined {
  const entry = catalogueEntryFor(file);
  if (entry) return entry.sdcpp;
  if (/x2|2x/i.test(file) && /realesrgan/i.test(file)) return false;
  return SDCPP_KNOWN.some((pattern) => pattern.test(file)) ? true : undefined;
}
