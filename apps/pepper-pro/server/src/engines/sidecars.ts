import { copyFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * The latent sidecars a MiniMax H3 take carries (the obvpm `mctx_v1`
 * convention): `clip.mp4` sits beside `clip.mctx.safetensors`, the take's
 * raw video and audio latents, and `clip.cond.safetensors`, the
 * conditioning it was sampled under. They are what lets a later job
 * continue the take, or refine it, with no VAE round trip, so they travel
 * with the video wherever Pepper copies or moves it, always under the
 * video's own name.
 */
export const SIDECAR_SUFFIXES = ['.mctx.safetensors', '.cond.safetensors'] as const;

/** `dir/name.mp4` → `dir/name.mctx.safetensors` (and `.cond`). */
export function sidecarPath(video: string, suffix: (typeof SIDECAR_SUFFIXES)[number]): string {
  return join(dirname(video), `${basename(video, extname(video))}${suffix}`);
}

/** Whether a video has its latents beside it (the `.mctx`; the `.cond` is needed only to refine). */
export async function hasLatents(video: string): Promise<boolean> {
  try {
    return (await stat(sidecarPath(video, '.mctx.safetensors'))).isFile();
  } catch {
    return false;
  }
}

/**
 * Copy (or move) a video's sidecars to sit beside `target`, renamed to
 * match it. Missing sidecars are skipped: most videos have none.
 */
export async function carrySidecars(source: string, target: string, how: 'copy' | 'move' = 'copy'): Promise<number> {
  let carried = 0;
  for (const suffix of SIDECAR_SUFFIXES) {
    const from = sidecarPath(source, suffix);
    try {
      await stat(from);
    } catch {
      continue;
    }
    const to = sidecarPath(target, suffix);
    if (how === 'move') {
      await rename(from, to).catch(async () => {
        await copyFile(from, to);
        await rm(from, { force: true });
      });
    } else {
      await copyFile(from, to);
    }
    carried++;
  }
  return carried;
}

/** Remove a video's sidecars, if it has any. */
export async function removeSidecars(video: string): Promise<void> {
  await Promise.all(SIDECAR_SUFFIXES.map((suffix) => rm(sidecarPath(video, suffix), { force: true })));
}
