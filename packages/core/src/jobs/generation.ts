import type { Job } from './manager.js';

/**
 * What a client shows beside a generated file: how long it took, what made
 * it and from what prompt. Each product's engines name these differently
 * (Pepper's metadata has `model`, Pepper Pro's has `recipe` and nests the
 * request's values under `params`), so this reads both rather than every
 * screen guessing on its own. The web client's `generationOf` mirrors it for
 * jobs it already holds.
 */
export interface Generation {
  job_id: string;
  /** The recipe (Pepper Pro) or model (Pepper) that made it. */
  source?: string;
  mode?: string;
  /** `upscale`, `music` and the like, for jobs that are not a plain generation. */
  task?: string;
  prompt?: string;
  negative_prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  /** LoRAs it was made with (Pepper Pro's library), at the strength used. */
  loras?: { id?: string; name: string; strength: number }[];
  /** From the job starting to it finishing: model loading included, queueing not. */
  duration_ms?: number;
  /** How long it sat in the queue first. */
  wait_ms?: number;
  created_at: string;
  started_at?: string;
  finished_at?: string;
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
/** LoRAs as a job's metadata records them, else as it asked for them (ids only, before it ran). */
export function lorasOf(metadata: Record<string, unknown>, params: Record<string, unknown>): Generation['loras'] {
  const list = Array.isArray(metadata.loras) ? metadata.loras : Array.isArray(params.loras) ? params.loras : [];
  const loras = list.flatMap((item) => {
    const entry = record(item);
    const name = str(entry.name) ?? str(entry.id);
    return name ? [{ id: str(entry.id), name, strength: num(entry.strength) ?? 1 }] : [];
  });
  return loras.length ? loras : undefined;
}

const record = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function describeGeneration(job: Job): Generation {
  const metadata = record(job.result?.metadata);
  // Pepper Pro's recipe jobs carry the recipe's own values under `params`.
  const values = job.params.recipe ? record(job.params.params) : job.params;
  const created = Date.parse(job.createdAt);
  const started = job.startedAt ? Date.parse(job.startedAt) : undefined;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : undefined;
  return {
    job_id: job.id,
    source: str(job.params.recipe) ?? str(metadata.recipe) ?? str(metadata.model) ?? str(job.params.model),
    mode: str(job.params.mode) ?? str(metadata.mode),
    task: str(metadata.task) ?? str(job.params.task),
    prompt: str(metadata.prompt) ?? str(values.prompt) ?? str(values.input),
    negative_prompt: str(metadata.negative_prompt) ?? str(values.negative_prompt),
    seed: num(metadata.seed) ?? num(values.seed),
    width: num(metadata.width) ?? num(values.width),
    height: num(metadata.height) ?? num(values.height),
    loras: lorasOf(metadata, job.params),
    // Wall time, so every engine is measured the same way; an engine's own
    // figure is the fallback for a job whose times were not recorded.
    duration_ms: started !== undefined && finished !== undefined ? finished - started : num(metadata.duration_ms),
    wait_ms: started !== undefined ? Math.max(0, started - created) : undefined,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
  };
}

/** Every output URL a completed job's result names: its main file and, for Pepper Pro, the rest of `outputs`. */
export function outputUrls(job: Job): string[] {
  const result = record(job.result);
  const urls = [result.image_url, result.video_url, result.audio_url];
  if (Array.isArray(result.outputs)) urls.push(...result.outputs.map((output) => record(output).url));
  return [...new Set(urls.filter((url): url is string => typeof url === 'string'))];
}
