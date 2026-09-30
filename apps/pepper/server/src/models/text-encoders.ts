import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Paths } from '../paths.js';
import { readGgufInfo, type GgufInfo } from '@pepper/core/util/gguf.js';
import { stripExt } from '@pepper/core/util/files.js';
import type { ModelManager } from './manager.js';

/**
 * Text encoders that are whole chat LLMs, offered for text generation.
 *
 * Several image and video models condition on a full instruction-tuned LLM
 * (Z-Image and FLUX.2 on Qwen3, Qwen-Image 2.1 on Qwen3-VL), shipped as an
 * ordinary GGUF in the bundle's `clip/` folder. llama.cpp can serve those files
 * unchanged, so a user with an image model already has a text model on disk —
 * which matters on hosts where every GB has to be downloaded or persisted.
 *
 * What qualifies is read from the file, not the slot or filename: a GGUF with
 * a chat template and an architecture that generates. T5/umT5 (Wan) carry a
 * tokenizer but no chat template, and vision projectors carry neither, so both
 * drop out.
 */

export interface TextEncoderLlm {
  /** `<bundle>@<file stem>`: unique, stable across restarts, and a valid llama.cpp model name. */
  id: string;
  /** The file's stem, e.g. `Qwen3-4B-Instruct-2507-Q4_K_M`. */
  name: string;
  kind: 'image' | 'video';
  bundle: string;
  bundleName: string;
  file: string;
  path: string;
  architecture: string;
  size: number;
}

/** Encoder-only or non-text architectures; never chat models. */
const NOT_CHAT = new Set(['t5', 't5encoder', 'clip', 'bert', 'nomic-bert', 'jina-bert-v2']);

/**
 * ~1-bit quantizations (llama_ftype IQ1_S, IQ1_M, TQ1_0). Fine for
 * conditioning a diffusion model — FLUX.2 klein ships its Qwen3 encoder as
 * IQ1_S — but they answer a chat prompt with gibberish.
 */
const TOO_LOSSY_FOR_CHAT = new Set([24, 31, 36]);

/** Can llama.cpp hold a conversation with this GGUF? */
export function isChatLlm(info: GgufInfo): boolean {
  return (
    Boolean(info.architecture) &&
    !NOT_CHAT.has(info.architecture!) &&
    info.keys.has('tokenizer.ggml.model') &&
    info.keys.has('tokenizer.chat_template') &&
    !(info.fileType !== undefined && TOO_LOSSY_FOR_CHAT.has(info.fileType))
  );
}

const cache = new Map<string, { key: string; eligible: boolean; architecture?: string }>();

async function inspect(path: string, log: FastifyBaseLogger) {
  const s = await stat(path);
  const key = `${s.size}:${s.mtimeMs}`;
  const hit = cache.get(path);
  if (hit?.key === key) return hit;
  let entry: { key: string; eligible: boolean; architecture?: string };
  try {
    const info = await readGgufInfo(path);
    entry = { key, architecture: info.architecture, eligible: isChatLlm(info) };
  } catch (err) {
    log.debug({ path, err: (err as Error).message }, 'not a readable GGUF');
    entry = { key, eligible: false };
  }
  cache.set(path, entry);
  return entry;
}

export async function listTextEncoderLlms(
  paths: Paths,
  models: ModelManager,
  log: FastifyBaseLogger,
): Promise<TextEncoderLlm[]> {
  const out: TextEncoderLlm[] = [];
  for (const kind of ['image', 'video'] as const) {
    for (const bundle of await models.list(kind)) {
      for (const file of bundle.components) {
        if (file.slot !== 'clip' || !file.name.toLowerCase().endsWith('.gguf')) continue;
        const path = join(paths.modelsDir, kind, bundle.id, 'clip', file.name);
        const info = await inspect(path, log).catch(() => null);
        if (!info?.eligible) continue;
        out.push({
          id: `${bundle.id}@${stripExt(file.name)}`,
          name: stripExt(file.name),
          kind,
          bundle: bundle.id,
          bundleName: bundle.name,
          file: file.name,
          path,
          architecture: info.architecture!,
          size: file.size,
        });
      }
    }
  }
  return out;
}
