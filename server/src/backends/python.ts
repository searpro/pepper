import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import * as tar from 'tar';
import type { FastifyBaseLogger } from 'fastify';
import { errors } from '../errors.js';

const execFileAsync = promisify(execFile);

/**
 * Experimental Python backend support (requirement 5).
 *
 * "The current system supports executable binaries, we will eventually need to
 * use python backends as well… so we need to make the app ready to install and
 * run python backends. A possible candidate is comfyui (think of downloading
 * python runtime and running the package)."
 *
 * So this does exactly that: fetch a self-contained CPython build, unpack it
 * under `DATA_DIR/bin/python/`, create a venv from it, and install a package
 * into that venv. Nothing generates against it yet — it is wired through the
 * same `ManagedProcess` supervision as the C++ backends so that when a real
 * Python workload does arrive, the install/spawn/log/recycle path is one that
 * has been running in production all along, not new code written under
 * deadline.
 *
 * A *standalone* runtime rather than the system Python, because the production
 * image is `node:*-slim`: there may be no Python at all, and if there is, it
 * belongs to the distro and is the wrong thing to install packages into. The
 * runtime comes from `astral-sh/python-build-standalone`, the same
 * distribution `uv` uses.
 */

const PBS_REPO = 'astral-sh/python-build-standalone';
/** Pinned so a Python minor-version bump is never a silent surprise on redeploy. */
const PYTHON_VERSION = '3.12';

export interface PythonRuntime {
  /** The venv's interpreter — what packages are installed into and run with. */
  pythonPath: string;
  /** Root of the unpacked standalone runtime. */
  runtimeDir: string;
  venvDir: string;
  version: string;
  installedAt: string;
}

export interface PythonPackageSpec {
  /**
   * What to install. A git URL clones and installs from source (ComfyUI's
   * shape); a bare name installs from PyPI.
   */
  source: string;
  /** Module or script to launch once installed, e.g. `main.py` for ComfyUI. */
  entrypoint?: string;
}

const RECEIPT = 'python-runtime.json';

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export class PythonInstaller {
  constructor(
    /** `DATA_DIR/bin/python/` */
    private readonly installDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async installed(): Promise<PythonRuntime | null> {
    try {
      const receipt = JSON.parse(
        await readFile(join(this.installDir, RECEIPT), 'utf8'),
      ) as PythonRuntime;
      await stat(receipt.pythonPath);
      return receipt;
    } catch {
      return null;
    }
  }

  /**
   * Asset naming in python-build-standalone is
   * `cpython-3.12.8+20241219-x86_64-unknown-linux-gnu-install_only.tar.gz`.
   * The `install_only` variant is the one to take: the alternatives carry
   * debug symbols and build artifacts and are several times the size.
   */
  private selectRuntimeAsset(assets: GithubAsset[]): GithubAsset {
    const triple = runtimeTriple();
    const candidates = assets.filter(
      (a) =>
        a.name.startsWith(`cpython-${PYTHON_VERSION}.`) &&
        a.name.includes(triple) &&
        a.name.includes('install_only') &&
        a.name.endsWith('.tar.gz'),
    );
    if (candidates.length === 0) {
      throw errors.backendInstallFailed(
        'python',
        `No CPython ${PYTHON_VERSION} build for ${triple} in the latest ${PBS_REPO} release`,
      );
    }
    // Names sort lexicographically by their embedded date stamp, so the last
    // one is the newest patch release.
    return candidates.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  }

  async installRuntime(signal?: AbortSignal): Promise<PythonRuntime> {
    const existing = await this.installed();
    if (existing) return existing;

    const res = await fetch(`https://api.github.com/repos/${PBS_REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'pepper',
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal,
    });
    if (!res.ok) {
      throw errors.backendInstallFailed(
        'python',
        `Failed to query ${PBS_REPO}: HTTP ${res.status} ${res.statusText}`,
      );
    }

    const release = (await res.json()) as { tag_name: string; assets: GithubAsset[] };
    const asset = this.selectRuntimeAsset(release.assets ?? []);
    this.log.info({ asset: asset.name }, 'downloading standalone Python runtime');

    const tmpFile = join(tmpdir(), `pepper-python-${randomUUID()}.tar.gz`);
    const download = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'pepper' },
      signal,
      redirect: 'follow',
    });
    if (!download.ok || !download.body) {
      throw errors.backendInstallFailed(
        'python',
        `Failed to download ${asset.name}: HTTP ${download.status}`,
      );
    }

    try {
      await pipeline(
        Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmpFile),
      );

      const runtimeDir = resolve(this.installDir, 'runtime');
      const staging = `${runtimeDir}.staging-${randomUUID()}`;
      await mkdir(staging, { recursive: true });
      await tar.x({ file: tmpFile, cwd: staging });

      await rm(runtimeDir, { recursive: true, force: true });
      await rename(staging, runtimeDir);

      // The archive unpacks to a single `python/` directory.
      const basePython = await findInterpreter(runtimeDir);
      if (!basePython) {
        throw errors.backendInstallFailed('python', 'Runtime archive contained no interpreter');
      }

      // A venv on top of the standalone build, so package installs never touch
      // the runtime itself and can be wiped and rebuilt independently.
      const venvDir = resolve(this.installDir, 'venv');
      await rm(venvDir, { recursive: true, force: true });
      await this.run(basePython, ['-m', 'venv', venvDir], signal);

      const pythonPath = join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', 'python');
      await stat(pythonPath);

      const receipt: PythonRuntime = {
        pythonPath,
        runtimeDir,
        venvDir,
        version: asset.name,
        installedAt: new Date().toISOString(),
      };
      await writeFile(join(this.installDir, RECEIPT), JSON.stringify(receipt, null, 2), 'utf8');
      this.log.info({ pythonPath }, 'Python runtime ready');
      return receipt;
    } finally {
      await rm(tmpFile, { force: true }).catch(() => {});
    }
  }

  /** Install a package into the venv. Long-running — callers should not block a request on it. */
  async installPackage(
    runtime: PythonRuntime,
    spec: PythonPackageSpec,
    signal?: AbortSignal,
  ): Promise<string> {
    const packagesDir = resolve(this.installDir, 'packages');
    await mkdir(packagesDir, { recursive: true });

    if (isGitSource(spec.source)) {
      // ComfyUI is not a PyPI package: it is a repository you clone and run
      // in place, with its own requirements.txt. `pip install git+…` would
      // fail on it outright, so a source checkout is the only shape that works.
      const name = repoName(spec.source);
      const target = join(packagesDir, name);
      await rm(target, { recursive: true, force: true });
      await this.run('git', ['clone', '--depth', '1', spec.source, target], signal);

      const requirements = join(target, 'requirements.txt');
      if (await exists(requirements)) {
        await this.run(runtime.pythonPath, ['-m', 'pip', 'install', '-r', requirements], signal);
      }
      return target;
    }

    await this.run(runtime.pythonPath, ['-m', 'pip', 'install', spec.source], signal);
    return packagesDir;
  }

  private async run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
    this.log.info({ command, args }, 'python installer step');
    try {
      // Installs pull hundreds of megabytes of wheels; the default 10-minute
      // ceiling is the realistic one, not the default buffer-sized timeout.
      await execFileAsync(command, args, { signal, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      throw errors.backendInstallFailed(
        'python',
        `${command} ${args.join(' ')} failed: ${(err as Error).message}`,
      );
    }
  }
}

function isGitSource(source: string): boolean {
  return source.startsWith('git+') || source.endsWith('.git') || /^https?:\/\/[^\s]+\/[^\s]+$/.test(source);
}

function repoName(source: string): string {
  const cleaned = source.replace(/^git\+/, '').replace(/\.git$/, '');
  return cleaned.split('/').at(-1) || 'package';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findInterpreter(dir: string): Promise<string | null> {
  const names = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const name of names) {
    if (entries.some((e) => e.isFile() && e.name === name)) return join(dir, name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findInterpreter(join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

/** The platform triple python-build-standalone names its assets with. */
function runtimeTriple(platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') return 'x86_64-pc-windows-msvc';
  return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}
