import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegAvailable, runFfmpeg } from './ffmpeg.js';
import { Semaphore } from './semaphore.js';

/**
 * Small JPEG previews of images and videos, for the grids that list them.
 *
 * A library of a few hundred outputs crashed the browser tab: every video tile
 * was a `<video preload="metadata">`, and each one holds a decoder and a full
 * frame (a 1728×3072 take is ~21 MB decoded), so a page of them ran the tab
 * out of memory long before it ran out of files. A 512px JPEG is tens of
 * kilobytes, decodes in the image pipeline the browser already lazy-loads, and
 * is made once per file.
 *
 * Thumbnails live in the cache directory, named by the source's path, size and
 * modification time, so a file rewritten under the same name gets a new one
 * and nothing has to be invalidated by hand.
 */

/** The long side of a thumbnail: a grid tile at twice its CSS size on a wide screen. */
const SIZE = 512;
/** Old enough that nobody is looking at it; a thumbnail is cheap to make again. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A grid asks for every visible tile at once; a few ffmpegs at a time keeps
// that from starving a render that is running on the same machine.
const slots = new Semaphore(3);
const pending = new Map<string, Promise<string>>();

export function thumbnailPath(thumbDir: string, source: string, size: number, mtimeMs: number): string {
  const key = createHash('sha1').update(`${source}\0${size}\0${Math.round(mtimeMs)}`).digest('hex').slice(0, 24);
  return join(thumbDir, `${key}.jpg`);
}

/**
 * The thumbnail of an image or video at `source`, made on first request.
 * Returns null when ffmpeg is absent or cannot read the file, so the caller
 * can fall back to the original.
 */
export async function thumbnail(thumbDir: string, source: string, kind: 'image' | 'video'): Promise<string | null> {
  const info = await stat(source);
  const out = thumbnailPath(thumbDir, source, info.size, info.mtimeMs);
  try {
    await stat(out);
    return out;
  } catch {
    // Not made yet.
  }
  if (!(await ffmpegAvailable())) return null;

  // Two tiles for the same file (a grid and a viewer strip) share one ffmpeg.
  let job = pending.get(out);
  if (!job) {
    job = slots.run(() => render(source, out, kind)).finally(() => pending.delete(out));
    pending.set(out, job);
  }
  try {
    return await job;
  } catch {
    return null;
  }
}

async function render(source: string, out: string, kind: 'image' | 'video'): Promise<string> {
  await mkdir(join(out, '..'), { recursive: true });
  const tmp = `${out.slice(0, -4)}.${process.pid}.tmp.jpg`;
  const scale = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const encode = ['-frames:v', '1', '-vf', scale, '-q:v', '5', tmp];
  try {
    if (kind === 'video') {
      // A tenth of a second in, past the black or blank first frame some
      // encoders write; a clip shorter than that falls back to its first frame.
      await runFfmpeg(['-ss', '0.1', '-i', source, ...encode], 30_000).catch(() =>
        runFfmpeg(['-i', source, ...encode], 30_000),
      );
    } else {
      await runFfmpeg(['-i', source, ...encode], 30_000);
    }
    await rename(tmp, out);
    return out;
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Remove thumbnails not made in the last week, whose files have usually been swept anyway. */
export async function sweepThumbnails(thumbDir: string, maxAgeMs = MAX_AGE_MS): Promise<number> {
  let names: string[];
  try {
    names = await readdir(thumbDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    const path = join(thumbDir, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await unlink(path);
        removed++;
      }
    } catch {
      // Raced with a reader or another sweep; skip it.
    }
  }
  return removed;
}
