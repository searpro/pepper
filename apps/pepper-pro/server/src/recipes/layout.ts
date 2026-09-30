import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentPaths, DownloadLayout } from '@pepper/core/downloads/manager.js';
import { errors } from '@pepper/core/errors.js';
import { assertSafeName, safeResolve, safeResolveNested } from '@pepper/core/paths.js';
import { COMFY_FOLDERS, type ProPaths } from '../paths.js';

/**
 * Where Pepper Pro's downloads land. The download table's three coordinates
 * mean: kind `comfy` with the ComfyUI folder as the bundle (a file serving
 * several recipes is stored once), or kind `llm` with bundle `llm` for a GGUF
 * llama.cpp scans. The slot is always `file`.
 */

export const DOWNLOAD_KINDS = ['comfy', 'llm'] as const;
export type DownloadKind = (typeof DOWNLOAD_KINDS)[number];
export type DownloadSlot = 'file';

export function comfyLayout(paths: ProPaths): DownloadLayout<DownloadKind, DownloadSlot> {
  // A bundle is a ComfyUI folder, optionally followed by sub-directories for
  // checkpoints a node pack loads as a directory (`tts/Qwen3-TTS/<model>`).
  const dirFor = (kind: DownloadKind, bundle: string): string => {
    if (kind === 'llm') return paths.llmDir;
    const [folder, ...rest] = bundle.split('/');
    if (!(COMFY_FOLDERS as readonly string[]).includes(folder)) {
      throw errors.validation(`"${folder}" is not a ComfyUI model folder (${COMFY_FOLDERS.join(', ')})`);
    }
    return safeResolveNested(join(paths.modelsDir, folder), ...rest);
  };
  const validateName = (name: string): string => {
    assertSafeName(name);
    return name;
  };
  return {
    parseSlot(value: string): DownloadSlot {
      if (value !== 'file') throw errors.validation(`Unknown slot "${value}"; Pepper Pro downloads use "file"`);
      return 'file';
    },
    fileNameFor(url: string, explicit?: string): string {
      if (explicit) return validateName(explicit);
      let candidate: string;
      try {
        candidate = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      } catch {
        throw errors.validation(`Cannot derive a filename from URL: ${url}`);
      }
      if (!candidate) throw errors.validation(`Cannot derive a filename from URL: ${url}`);
      return validateName(candidate);
    },
    async componentPaths(kind: DownloadKind, bundle: string, _slot: DownloadSlot, name: string): Promise<ComponentPaths> {
      const dir = dirFor(kind, bundle);
      await mkdir(dir, { recursive: true });
      const finalPath = safeResolve(dir, validateName(name));
      return { dir, finalPath, tmpPath: `${finalPath}.part`, metaPath: `${finalPath}.part.json` };
    },
  };
}
