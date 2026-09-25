import { api, type Job, type MediaItem } from '@/lib/api';

/**
 * Shared plumbing for the image screens: what an output's info looks like, the
 * reuse/upscale calls, and the hand-off that lets the Media page send an image
 * or its settings over to the Image screen.
 */

/** Generation settings as recorded in a job's result metadata. */
export interface ImageSettings {
  prompt?: string;
  negative_prompt?: string;
  model?: string;
  steps?: number;
  cfg_scale?: number;
  width?: number;
  height?: number;
  seed?: number;
  sampler?: string;
  init_image?: string;
  strength?: number;
  ref_images?: string[];
  img_cfg_scale?: number;
  increase_ref_index?: boolean;
  duration_ms?: number;
  /** Set on upscaled outputs. */
  task?: 'upscale';
  scale?: number;
  source_image?: string;
  source_width?: number;
  source_height?: number;
  upscaler?: string;
  upscale_method?: string;
}

export interface OutputInfo {
  name: string;
  kind: MediaItem['kind'];
  size: number;
  modified: string;
  url: string;
  job: {
    id: string;
    params: Record<string, unknown>;
    metadata: ImageSettings | null;
    createdAt: string;
    finishedAt?: string;
  } | null;
}

export interface UpscalerModel {
  name: string;
  scale: number;
  size: number;
  label: string;
  description?: string;
  architecture?: string;
  bestFor?: 'general' | 'photo' | 'illustration' | 'fast';
  license?: string;
  sdcpp?: boolean;
}

export interface UpscalerCatalogueEntry {
  id: string;
  file: string;
  label: string;
  description: string;
  scale: 2 | 4;
  architecture: string;
  bestFor: 'general' | 'photo' | 'illustration' | 'fast';
  license: string;
  sizeBytes: number;
  sdcpp: boolean;
  installed: boolean;
  installing: boolean;
}

export interface UpscalerInfo {
  dir: string;
  models: UpscalerModel[];
  scales: (2 | 4)[];
  preferences: { engine: 'auto' | 'python' | 'sdcpp'; default_x2: string | null; default_x4: string | null };
  /** The checkpoint each scale uses when none is named. */
  defaults: { 2: string | null; 4: string | null };
  pythonReady: boolean;
  catalogue: UpscalerCatalogueEntry[];
}

export const inputUrl = (name: string) => `/v1/inputs/${encodeURIComponent(name)}`;
export const outputUrl = (name: string) => `/v1/outputs/${encodeURIComponent(name)}`;

/** The settings an output was made with, falling back to the submitted params. */
export function settingsOf(info: OutputInfo | undefined): ImageSettings | null {
  if (!info?.job) return null;
  return { ...(info.job.params as ImageSettings), ...(info.job.metadata ?? {}) };
}

/** Human-readable settings block, for the clipboard. */
export function formatSettings(settings: ImageSettings): string {
  const lines = [
    settings.prompt ? `Prompt: ${settings.prompt}` : null,
    settings.negative_prompt ? `Negative prompt: ${settings.negative_prompt}` : null,
    [
      settings.model && `Model: ${settings.model}`,
      settings.width && settings.height && `Size: ${settings.width}x${settings.height}`,
      settings.steps !== undefined && `Steps: ${settings.steps}`,
      settings.cfg_scale !== undefined && `CFG scale: ${settings.cfg_scale}`,
      settings.sampler && `Sampler: ${settings.sampler}`,
      settings.seed !== undefined && `Seed: ${settings.seed}`,
      settings.strength !== undefined && `Denoising strength: ${settings.strength}`,
      settings.img_cfg_scale !== undefined && `Image CFG scale: ${settings.img_cfg_scale}`,
    ]
      .filter(Boolean)
      .join(', '),
  ];
  return lines.filter(Boolean).join('\n');
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain-HTTP origins (a LAN deployment) have no async clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export function upscale(
  name: string,
  scale: 2 | 4,
  source: 'output' | 'upload' = 'output',
  upscaler?: string,
) {
  return api.post<Job>('/v1/jobs/upscale', {
    image: name,
    source,
    scale,
    ...(upscaler ? { upscaler } : {}),
  });
}

/** Copy an output into uploads so it can be an init or reference image. */
export async function outputToInput(name: string): Promise<string> {
  const result = await api.post<{ name: string }>('/v1/inputs/from-output', { name });
  return result.name;
}

// --- Hand-off to the Image screen -------------------------------------------

/**
 * What another screen asks the Image screen to load. Held in sessionStorage
 * for the length of one navigation: a router state would be lost on reload,
 * and localStorage would replay it in every other tab.
 */
export interface ImageHandoff {
  settings?: ImageSettings;
  init?: string;
  refs?: string[];
}

const HANDOFF_KEY = 'pepper-image-handoff';

export function setHandoff(handoff: ImageHandoff): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // Storage disabled: the navigation still happens, just without the payload.
  }
}

export function takeHandoff(): ImageHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_KEY);
    return raw ? (JSON.parse(raw) as ImageHandoff) : null;
  } catch {
    return null;
  }
}

// --- Hand-off to the Video screen -------------------------------------------

/** What another screen asks the Video screen to load: a start image, or a video's settings. */
export interface VideoHandoff {
  init?: string;
  settings?: Record<string, unknown>;
}

const VIDEO_HANDOFF_KEY = 'pepper-video-handoff';

export function setVideoHandoff(handoff: VideoHandoff): void {
  try {
    sessionStorage.setItem(VIDEO_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // Storage disabled: the navigation still happens, just without the payload.
  }
}

export function takeVideoHandoff(): VideoHandoff | null {
  try {
    const raw = sessionStorage.getItem(VIDEO_HANDOFF_KEY);
    sessionStorage.removeItem(VIDEO_HANDOFF_KEY);
    return raw ? (JSON.parse(raw) as VideoHandoff) : null;
  } catch {
    return null;
  }
}
