import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineSetting } from '../db/settings.js';
import type { ModelManifest } from '../models/bundle.js';
import { bundleDir, type ModelKind, type Paths } from '../paths.js';

/**
 * vLLM-specific wiring (requirement: "vLLM-Omni as Inference Backend").
 *
 * Unlike llama.cpp (directory-scan router) or audio.cpp (generated JSON
 * registry), vLLM serves exactly one model per process and cannot hot-swap.
 * "Which model" is therefore a setting the user picks (Preferences, not the
 * generation screen — see the requirements doc), not something derived from
 * what is on disk. `backend.vllm.activeModel` holds that bundle id; the
 * `vllm` prepare hook (server.ts) reads it, resolves the bundle, and computes
 * the locked `model`/`served_model_name`/`model_class_name` args from its
 * manifest. Changing the setting restarts vLLM (`BackendManager.updateArgs`
 * already restarts on a settings change) with the new model.
 */

const execFileAsync = promisify(execFile);

/** Which installed bundle id vLLM currently serves. Empty string = none selected. */
export function vllmActiveModelKey() {
  return defineSetting<string>('backend.vllm.activeModel', z.string(), '');
}

/**
 * GPU count via `nvidia-smi -L` (one line per device). Falls back to 1 when
 * nvidia-smi is unavailable — a non-NVIDIA host, or a dev machine without a
 * GPU at all — since vLLM still runs single-device in that case.
 */
export async function detectGpuCount(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['-L'], { timeout: 5000 });
    const count = stdout.split('\n').filter((line) => line.trim().startsWith('GPU ')).length;
    return count > 0 ? count : 1;
  } catch {
    return 1;
  }
}

/**
 * Locked argv values for vLLM, derived from the bundle currently selected in
 * `backend.vllm.activeModel`. Throws if the bundle has no `huggingface_id` —
 * that field is what vLLM loads, and a bundle without it cannot be served.
 *
 * `--model` prefers a local snapshot over the bare HuggingFace id: if
 * `snapshotDownload()` (see `downloads/snapshot.ts`) has already pulled the
 * repo into the bundle directory, pointing vLLM at that directory is what
 * makes the snapshot download actually avoid a redundant fetch at spawn time
 * — passing the repo id instead would have vLLM re-download into its own HF
 * cache regardless of what pepper already has on disk.
 */
export async function vllmManagedValues(
  paths: Paths,
  bundle: { id: string; kind: ModelKind; name: string; manifest: ModelManifest | null },
): Promise<Record<string, string | number | boolean | null>> {
  const huggingfaceId = bundle.manifest?.huggingface_id;
  if (!huggingfaceId) {
    throw new Error(`Model "${bundle.id}" has no huggingface_id — required to serve it via vLLM`);
  }
  const dir = bundleDir(paths, bundle.kind, bundle.id);
  const hasLocalSnapshot = await stat(join(dir, 'config.json'))
    .then(() => true)
    .catch(() => false);
  return {
    model: hasLocalSnapshot ? dir : huggingfaceId,
    served_model_name: bundle.name,
    model_class_name: bundle.manifest?.vllm_pipeline_class ?? null,
  };
}
