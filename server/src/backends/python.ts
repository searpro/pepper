import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import { defineSetting } from '../db/settings.js';
import { errors } from '../errors.js';
import type { ModelManifest } from '../models/bundle.js';
import { bundleDir, type ModelKind, type Paths } from '../paths.js';

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
const RUNNER_RECEIPT = 'runner-env.json';

/**
 * Pepper's own Python package (`server/python/`): the `pepper_runner` module
 * and its requirements. Resolved from this file, so it is the same directory
 * whether the server runs from `src/` under tsx or from compiled `dist/`.
 */
export function runnerSourceDir(): string {
  return fileURLToPath(new URL('../../python', import.meta.url));
}

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
    options: { requirements?: boolean } = {},
  ): Promise<string> {
    const packagesDir = resolve(this.installDir, 'packages');
    await mkdir(packagesDir, { recursive: true });

    if (isGitSource(spec.source)) {
      // ComfyUI is not a PyPI package: it is a repository you clone and run
      // in place, with its own requirements.txt. `pip install git+…` would
      // fail on it outright, so a source checkout is the only shape that works.
      const { url, ref } = splitRef(spec.source);
      const name = repoName(url);
      const target = join(packagesDir, name);

      // Already cloned: skip re-cloning and re-installing requirements on
      // every spawn/restart. A package install is minutes of network and pip
      // resolution, and `ensureRunning` calls this on every start — not just
      // the first one.
      if (await exists(join(target, '.git'))) return target;

      await rm(target, { recursive: true, force: true });
      await this.run('git', ['clone', '--depth', '1', url, target], signal);
      // `<url>#<commit>` pins the checkout: a runner written against one
      // revision of upstream's model code should not meet another silently.
      if (ref) {
        await this.run('git', ['-C', target, 'fetch', '--depth', '1', 'origin', ref], signal);
        await this.run('git', ['-C', target, 'checkout', '--detach', ref], signal);
      }

      // Runner-backed models clone upstream only for its model code: their
      // dependencies are Pepper's runner environment, and upstream's own
      // requirements.txt (EchoMimicV3's pins TensorFlow 2.15) may not even
      // install on the runtime's Python.
      const requirements = join(target, 'requirements.txt');
      if (options.requirements !== false && (await exists(requirements))) {
        await this.run(runtime.pythonPath, ['-m', 'pip', 'install', '-r', requirements], signal);
      }
      return target;
    }

    await this.run(runtime.pythonPath, ['-m', 'pip', 'install', spec.source], signal);
    return packagesDir;
  }

  /** Where `installPackage` places (or has placed) a git-sourced package. */
  packageDir(source: string): string {
    return resolve(this.installDir, 'packages', repoName(splitRef(source).url));
  }

  /**
   * Install `pepper_runner`'s requirements (torch, diffusers, transformers…)
   * into the venv. Skipped when the receipt says this exact requirements file
   * is already installed, so it costs a hash on every job rather than a pip
   * resolve; editing requirements.txt reinstalls on the next job.
   */
  async ensureRunnerEnvironment(runtime: PythonRuntime, signal?: AbortSignal): Promise<void> {
    const requirements = join(runnerSourceDir(), 'requirements.txt');
    const hash = createHash('sha256')
      .update(await readFile(requirements))
      .digest('hex');
    const receiptPath = join(this.installDir, RUNNER_RECEIPT);
    const receipt = await readFile(receiptPath, 'utf8')
      .then((text) => JSON.parse(text) as { hash?: string; python?: string })
      .catch(() => null);
    if (receipt?.hash === hash && receipt.python === runtime.pythonPath) return;

    this.log.info({ requirements }, 'installing Python runner environment (torch, diffusers, …)');
    await this.run(runtime.pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'], signal);
    await this.run(runtime.pythonPath, ['-m', 'pip', 'install', '-r', requirements], signal);
    await writeFile(
      receiptPath,
      JSON.stringify(
        { hash, python: runtime.pythonPath, installedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    this.log.info('Python runner environment ready');
  }

  private async run(command: string, args: string[], signal?: AbortSignal): Promise<void> {
    this.log.info({ command, args }, 'python installer step');
    try {
      // Installs pull gigabytes of wheels (torch alone is hundreds of MB), so
      // the ceiling is generous; a stalled install still ends eventually.
      await execFileAsync(command, args, {
        signal,
        timeout: 45 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      throw errors.backendInstallFailed(
        'python',
        `${command} ${args.join(' ')} failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Which installed bundle id the Python backend currently serves. Mirrors
 * `vllmActiveModelKey`: like vLLM, whatever is spawned here is a persistent
 * process serving one model, not a per-request choice, so "which model" is a
 * setting rather than a field on the generation request.
 */
export function pythonActiveModelKey() {
  return defineSetting<string>('backend.python.activeModel', z.string(), '');
}

/**
 * Locked argv for the Python backend, derived from the bundle currently
 * selected in `backend.python.activeModel`.
 *
 * Unlike vLLM, spawning nothing useful yet is the *normal* state here even
 * with a model selected: the package (`python_package`) has to be installed
 * into the venv first, and that is minutes of git clone and pip resolution —
 * too slow to run inline from a request-triggered prepare hook, the same
 * reason the standalone runtime itself is installed explicitly
 * (`POST /v1/backends/python/install`) rather than on first use. So this
 * throws with a specific, actionable reason whenever the package is not
 * already on disk, and the caller (the `python` prepare hook in `server.ts`)
 * turns that into a `skip` rather than a startup failure.
 */
export async function pythonManagedValues(
  paths: Paths,
  installer: PythonInstaller,
  bundle: { id: string; kind: ModelKind; name: string; manifest: ModelManifest | null },
): Promise<{ argvPrefix: string[]; healthPath?: string }> {
  const manifest = bundle.manifest;
  const source = manifest?.python_package;
  const entrypointRel = manifest?.python_entrypoint;
  if (manifest?.python_runner) {
    throw new Error(
      `Model "${bundle.id}" runs per job through Pepper's "${manifest.python_runner}" runner — there is no server to start`,
    );
  }
  if (!source || !entrypointRel) {
    throw new Error(
      `Model "${bundle.id}" has no python_package/python_entrypoint — required to serve it via the Python backend`,
    );
  }

  const runtime = await installer.installed();
  if (!runtime) {
    throw new Error('Python runtime not installed yet — install it from Preferences first');
  }

  const packageDir = installer.packageDir(source);
  const hasPackage = await stat(join(packageDir, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!hasPackage) {
    throw new Error(
      `"${source}" is not installed into the Python venv yet — install the backend from Preferences to clone it`,
    );
  }

  const entrypoint = join(packageDir, entrypointRel);
  await stat(entrypoint).catch(() => {
    throw new Error(`Entrypoint "${entrypointRel}" not found in ${source}`);
  });

  const dir = bundleDir(paths, bundle.kind, bundle.id);
  const flagArgs: string[] = [];
  for (const [slot, flag] of Object.entries(manifest?.python_component_flags ?? {})) {
    const slotDir = join(dir, slot.startsWith('other:') ? slot.slice('other:'.length) : slot);
    const hasContent = await readdir(slotDir)
      .then((entries) => entries.length > 0)
      .catch(() => false);
    // A declared-but-empty slot is skipped rather than passed as an empty
    // directory: the entrypoint script would rather see the flag omitted than
    // see it pointed at nothing.
    if (hasContent) flagArgs.push(flag, slotDir);
  }

  return {
    argvPrefix: [entrypoint, ...flagArgs],
    healthPath: manifest?.python_health_path,
  };
}

/** Ensure the active Python model's package is installed. Long-running — call from an explicit install action, not a request. */
export async function ensurePythonPackageInstalled(
  installer: PythonInstaller,
  manifest: ModelManifest | null,
  signal?: AbortSignal,
): Promise<void> {
  const source = manifest?.python_package;
  if (!source) return;
  const runtime = await installer.installRuntime(signal);
  // A runner bundle's package is upstream model code only; its dependencies
  // are the runner environment, not upstream's requirements.txt.
  await installer.installPackage(runtime, { source }, signal, {
    requirements: !manifest?.python_runner,
  });
}

function isGitSource(source: string): boolean {
  return source.startsWith('git+') || source.endsWith('.git') || /^https?:\/\/[^\s]+\/[^\s]+$/.test(source);
}

/** `https://github.com/org/repo#<commit>` -> url and optional pinned ref. */
function splitRef(source: string): { url: string; ref?: string } {
  const [url, ref] = source.split('#');
  return { url, ref: ref || undefined };
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
    // python-build-standalone ships `bin/python3` as a symlink to
    // `python3.12`, so a symlink counts as much as a regular file.
    if (entries.some((e) => (e.isFile() || e.isSymbolicLink()) && e.name === name))
      return join(dir, name);
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
