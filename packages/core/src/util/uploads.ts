import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { safeResolve } from '../paths.js';

/**
 * Inputs used to pile up: every upload, URL fetch and reuse of a generated
 * file wrote a new timestamped copy, so the same reference image picked for
 * ten shots was ten files. These keep one file per distinct input.
 */

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Store bytes as an upload named by their content, so the same file uploaded
 * twice is one file. Written to a temporary name and renamed, so a reader
 * never sees half of it and two identical uploads at once cannot clash.
 */
export async function storeUpload(uploadsDir: string, data: Buffer, ext: string): Promise<string> {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 20);
  const name = `upload-${hash}.${ext.replace(/^\./, '').toLowerCase() || 'bin'}`;
  const path = safeResolve(uploadsDir, name);
  if (await exists(path)) return name;
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
  return name;
}

/**
 * Make a generated output usable as an input. It is kept in uploads rather
 * than referenced, because outputs are swept by the retention timer and a
 * job queued against one should not fail when it ages out. A hard link costs
 * no space and survives the output's deletion; a copy is the fallback where
 * the two folders are on different filesystems. Picking the same output again
 * reuses the first import.
 */
export async function importOutput(outputDir: string, uploadsDir: string, outputName: string): Promise<string> {
  const source = safeResolve(outputDir, outputName);
  const name = `from-${outputName}`;
  const target = safeResolve(uploadsDir, name);
  if (await exists(target)) return name;
  try {
    await link(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return name;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await copyFile(source, temp);
    await rename(temp, target).catch(async (error) => {
      await unlink(temp).catch(() => {});
      throw error;
    });
  }
  return name;
}
