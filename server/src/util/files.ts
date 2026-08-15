import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { delimiter, extname, join, resolve } from 'node:path';

/** A timestamped, collision-resistant output filename. */
export function uniqueOutputName(ext: string, prefix = ''): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${prefix ? `${prefix}-` : ''}${stamp}-${suffix}.${ext.replace(/^\./, '')}`;
}

/** Does an executable exist at this path, or on PATH if it is a bare command? */
export async function isExecutableAvailable(binary: string): Promise<boolean> {
  if (binary.includes('/') || binary.includes('\\')) {
    try {
      await access(resolve(binary), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        await access(join(dir, binary + ext), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

export interface FileEntry {
  name: string;
  size: number;
  modified: number;
}

/**
 * List the regular files in a directory. A missing directory yields an empty
 * list rather than throwing: "no bundle here yet" is an ordinary state during
 * a fresh install, not an error, and every caller would otherwise have to
 * catch ENOENT itself.
 */
export async function listFiles(
  dir: string,
  options: { includePartials?: boolean } = {},
): Promise<FileEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: FileEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!options.includePartials && (name.endsWith('.part') || name.endsWith('.part.json'))) {
      continue;
    }
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) out.push({ name, size: s.size, modified: s.mtimeMs });
    } catch {
      // Raced with a delete; skip it.
    }
  }
  return out;
}

/** List sub-directory names. Missing directory yields an empty list. */
export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Total size of a directory tree, in bytes. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true }) as never;
  } catch {
    return 0;
  }
  for (const entry of entries as unknown as { name: string; isDirectory(): boolean; isFile(): boolean }[]) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // raced with a delete
      }
    }
  }
  return total;
}

/** Filename without its extension — how a LoRA is referenced in a prompt. */
export function stripExt(name: string): string {
  return name.slice(0, name.length - extname(name).length);
}
