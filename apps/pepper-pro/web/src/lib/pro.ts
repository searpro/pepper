import { api, type Job } from '@pepper/ui/lib/api';

/**
 * Pepper Pro's API types, as the server returns them (routes/recipes.ts,
 * routes/projects.ts). Rows keep the server's camelCase column names.
 */

export type RecipeKind = 'image' | 'video' | 'audio';

export interface RecipeParam {
  name: string;
  type: 'string' | 'text' | 'int' | 'float' | 'boolean' | 'enum' | 'seed' | 'image' | 'images' | 'audio' | 'audios' | 'video';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  options?: (string | number)[];
  max_items?: number;
}

export interface Licence {
  id: string;
  name: string;
  url?: string;
  commercial: 'yes' | 'no' | 'under-1M' | 'under-10M' | 'under-20M';
  excluded_territories: string[];
  ui_notice?: string;
  obligations: string[];
}

export interface Recipe {
  id: string;
  version: number;
  kind: RecipeKind;
  name: string;
  description: string;
  family: string;
  capabilities: string[];
  licence: Licence;
  tiers: string[];
  modes: { id: string; label: string; description?: string }[];
  default_mode: string;
  params: RecipeParam[];
  verified?: { date: string; gpu: string; seconds?: number; notes?: string };
  notes?: string;
  state: 'installed' | 'partial' | 'missing';
  tier_verified: boolean;
  licence_block?: string;
  missing_bytes: number;
  files: { id: string; label: string; folder: string; name: string; optional: boolean; installed: boolean; bytes?: number }[];
}

export interface RecipeList {
  tier: string;
  licence_mode: 'personal' | 'commercial';
  recipes: Recipe[];
  broken: { id: string; error: string }[];
}

export const ASPECTS = ['9:16', '16:9', '1:1', '4:5', '4:3', '3:4', '21:9'] as const;
export const SHOT_KINDS = ['dialogue', 'action', 'talking', 'performance', 'broll', 'product', 'establishing'] as const;
export const ASSET_KINDS = ['character', 'location', 'prop', 'product', 'voice', 'audio', 'style'] as const;

export interface Project {
  id: string;
  name: string;
  description: string;
  aspect: string;
  fps: number;
  style: string;
  lut: string | null;
  licenceMode: 'personal' | 'commercial';
  script: string;
  createdAt: number;
  updatedAt: number;
}

export interface Asset {
  id: string;
  projectId: string | null;
  kind: string;
  name: string;
  description: string;
  images: string[];
  voice: { upload?: string; description?: string } | null;
  audio: string | null;
  meta: Record<string, unknown>;
}

export interface DialogueLine {
  asset_id?: string;
  speaker?: string;
  line: string;
}

export interface Take {
  id: string;
  shotId: string;
  jobId: string;
  mode: string;
  seed: number | null;
  file: string | null;
  score: number | null;
  notes: string;
  createdAt: number;
  status: Job['status'] | 'missing';
  progress: number;
  error?: { code: string; message: string };
  url?: string;
  kind?: RecipeKind;
  /** A vision model's check against the shot (analyze task `check`). */
  review: { ok: boolean; score: number; issues: string[]; model: string; at: number } | null;
}

export interface Shot {
  id: string;
  sceneId: string;
  position: number;
  kind: string;
  durationS: number;
  framing: string;
  camera: string;
  prompt: string;
  dialogue: DialogueLine[];
  sound: string;
  assetIds: string[];
  keyframes: { first?: string; last?: string };
  audioAssetId: string | null;
  recipeId: string | null;
  params: Record<string, unknown>;
  chosenTakeId: string | null;
  takes: Take[];
}

export interface Scene {
  id: string;
  position: number;
  title: string;
  notes: string;
  shots: Shot[];
}

export interface CutItem {
  take_id: string;
  in?: number;
  out?: number;
  transition?: 'cut' | 'fade';
}

export interface Cut {
  id: string;
  name: string;
  items: CutItem[];
  music: { asset_id: string; gain_db?: number; duck?: boolean } | null;
  subtitles: boolean;
  beatSync: boolean;
  export: { status: Job['status']; progress: number; error?: { message: string }; result?: Record<string, unknown> } | null;
}

/** What `analyze` beats stores on an audio asset's meta. */
export interface BeatInfo {
  bpm: number;
  beats: number[];
  downbeats: number[];
  duration: number;
}

export function beatsOf(asset: Asset | undefined): BeatInfo | undefined {
  return (asset?.meta as { beats?: BeatInfo } | undefined)?.beats;
}

export interface ProjectDetail extends Project {
  assets: Asset[];
  scenes: Scene[];
  cuts: Cut[];
}

/** An upload's URL; assets and shots refer to uploads by name. */
export function inputUrl(name: string): string {
  return `/v1/inputs/${encodeURIComponent(name)}`;
}

/** Upload one file into inputs and return its stored name. */
export async function upload(file: File): Promise<string> {
  const result = await api.upload<{ name: string }>('/v1/inputs', file);
  return result.name;
}

export function isActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}
