import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import type { FastifyBaseLogger } from 'fastify';
import type { Accel } from '../config.js';

/** A backend's id, as its product's definitions name it. */
type BackendId = string;
import { errors } from '../errors.js';
import {
  isArchive,
  parseDriverCuda,
  runtimeCompanion,
  selectAsset,
  type ReleaseAsset,
  type SelectionResult,
} from './release.js';

const execFileAsync = promisify(execFile);

/**
 * Binary manager (requirement 6): install the **latest** release of a backend
 * from its configured `*_RELEASE_REPO`.
 *
 * Latest, never a pinned tag. sd-api had a `release_tag` setting defaulting to
 * `"latest"`, which meant a deployment could quietly pin itself to a stale
 * build and then be debugged against upstream's current source. Requirement 6
 * settles it: the repo is configurable, the version is not.
 *
 * The whole archive is extracted rather than just the executable, because
 * every one of these binaries links against sibling shared libraries
 * (`libstable-diffusion.so`, `libllama.so`, `libggml*.so`) that ship alongside
 * it in the same archive.
 */

export interface InstalledBinary {
  backend: BackendId;
  binaryPath: string;
  /** Release tag that was installed. */
  tag: string;
  asset: string;
  installedAt: string;
}

interface GithubRelease {
  tag_name: string;
  assets: ReleaseAsset[];
  published_at?: string;
}

/** Executable names to look for inside a release archive, in priority order. */
export const BINARY_NAMES: Record<string, string[]> = {
  sdcpp: ['sd-cli', 'sd-cli.exe', 'sd', 'sd.exe'],
  llamacpp: ['llama-server', 'llama-server.exe'],
  audiocpp: ['audiocpp_server', 'audiocpp_server.exe', 'audio-server', 'audio-server.exe'],
  // The Python backend is not a release archive at all — see `PythonInstaller`.
  python: [],
  // Not a release archive either — vLLM is baked into the image; see
  // `BackendManager.checkVllmBinary`.
  vllm: [],
};

/** Written next to an install so a restart knows what is already there. */
const RECEIPT = 'pepper-install.json';

export interface InstallerOptions {
  backend: BackendId;
  /** "owner/repo" whose latest release is installed. */
  repo: string;
  /** Directory the backend is installed into (`DATA_DIR/bin/<backend>/`). */
  installDir: string;
  accel: Accel;
  /** Executable names to look for in the archive; defaults to `BINARY_NAMES`. */
  binaryNames?: string[];
}

export class BinaryInstaller {
  constructor(
    private readonly options: InstallerOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Return the already-installed binary, if this backend has one. Reading the
   * receipt rather than scanning the directory means an install interrupted
   * halfway (killed container, full disk) is not mistaken for a good one — the
   * receipt is written last.
   */
  async installed(): Promise<InstalledBinary | null> {
    try {
      const receipt = JSON.parse(
        await readFile(join(this.options.installDir, RECEIPT), 'utf8'),
      ) as InstalledBinary;
      await stat(receipt.binaryPath);
      return receipt;
    } catch {
      return null;
    }
  }

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'pepper',
      Accept: 'application/vnd.github+json',
    };
    // Optional, but raises the anonymous 60 req/hr limit to 5000 — worth
    // having on a box that reinstalls backends on every cold start.
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** Fetch the latest release of the configured repo. */
  async latestRelease(signal?: AbortSignal): Promise<GithubRelease> {
    const url = `https://api.github.com/repos/${this.options.repo}/releases/latest`;
    const res = await fetch(url, { headers: this.apiHeaders(), signal });

    if (res.status === 404) {
      // A repo that only publishes pre-releases has no "latest" — GitHub
      // excludes pre-releases from that endpoint entirely. Fall back to the
      // release list, which includes them, rather than reporting the repo as
      // having no releases at all.
      return this.newestFromList(signal);
    }
    if (!res.ok) {
      throw errors.backendInstallFailed(
        this.options.backend,
        `Failed to query ${this.options.repo} latest release: HTTP ${res.status} ${res.statusText}${this.rateLimitHint(res)}`,
      );
    }
    return (await res.json()) as GithubRelease;
  }

  private async newestFromList(signal?: AbortSignal): Promise<GithubRelease> {
    const url = `https://api.github.com/repos/${this.options.repo}/releases?per_page=20`;
    const res = await fetch(url, { headers: this.apiHeaders(), signal });
    if (!res.ok) {
      throw errors.backendInstallFailed(
        this.options.backend,
        `Failed to list ${this.options.repo} releases: HTTP ${res.status} ${res.statusText}${this.rateLimitHint(res)}`,
      );
    }
    const releases = (await res.json()) as (GithubRelease & { draft?: boolean })[];
    const usable = releases.filter((r) => !r.draft && r.assets?.length > 0);
    if (usable.length === 0) {
      throw errors.backendInstallFailed(
        this.options.backend,
        `${this.options.repo} has no releases with downloadable assets`,
      );
    }
    return usable[0];
  }

  private rateLimitHint(res: Response): string {
    return res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
      ? ' (GitHub API rate limit exceeded — set GITHUB_TOKEN to raise it)'
      : '';
  }

  /** Download, extract and install the latest release. */
  async install(signal?: AbortSignal): Promise<InstalledBinary> {
    const maxCuda = this.options.accel === 'cuda' ? await driverCuda() : undefined;
    const pick = (release: GithubRelease): SelectionResult =>
      selectAsset(release.assets ?? [], process.platform, process.arch, this.options.accel, maxCuda);

    let release = await this.latestRelease(signal);
    let selection: SelectionResult;
    try {
      selection = pick(release);
    } catch (latestErr) {
      // llama.cpp's "latest" became a placeholder carrying only
      // nightly-tag.txt, with the builds published as pre-releases. Take the
      // newest release that has a build for this host instead.
      const found = await this.newestUsable(pick, signal);
      if (!found) throw errors.backendInstallFailed(this.options.backend, (latestErr as Error).message);
      [release, selection] = found;
    }
    const { asset, reason } = selection;
    const companion = runtimeCompanion(release.assets ?? [], asset);
    this.log.info(
      {
        backend: this.options.backend,
        tag: release.tag_name,
        asset: asset.name,
        runtime: companion?.name,
        accel: reason,
      },
      'selected release asset',
    );
    return this.installAsset(asset, release.tag_name, signal, companion);
  }

  private async newestUsable(
    pick: (release: GithubRelease) => SelectionResult,
    signal?: AbortSignal,
  ): Promise<[GithubRelease, SelectionResult] | null> {
    const url = `https://api.github.com/repos/${this.options.repo}/releases?per_page=20`;
    const res = await fetch(url, { headers: this.apiHeaders(), signal });
    if (!res.ok) return null;
    for (const release of (await res.json()) as (GithubRelease & { draft?: boolean })[]) {
      if (release.draft) continue;
      try {
        return [release, pick(release)];
      } catch {
        // No build for this host in this one; try the next.
      }
    }
    return null;
  }

  async installAsset(
    asset: ReleaseAsset,
    tag: string,
    signal?: AbortSignal,
    /** Extra archive whose libraries are placed next to the binary. */
    runtime?: ReleaseAsset,
  ): Promise<InstalledBinary> {
    const { backend, installDir } = this.options;
    if (!isArchive(asset.name)) {
      throw errors.backendInstallFailed(backend, `Asset ${asset.name} is not a supported archive`);
    }

    const tmpArchive = join(tmpdir(), `pepper-${backend}-${randomUUID()}-${suffixOf(asset.name)}`);
    const tmpRuntime = runtime
      ? join(tmpdir(), `pepper-${backend}-${randomUUID()}-${suffixOf(runtime.name)}`)
      : undefined;

    try {
      await this.download(asset, tmpArchive, signal);
      if (runtime && tmpRuntime) await this.download(runtime, tmpRuntime, signal);

      // Extract into a staging directory, then swap it into place — an
      // interrupted extraction never leaves a half-populated install that the
      // next boot would happily try to run.
      const targetDir = resolve(installDir, 'current');
      const stagingDir = `${targetDir}.staging-${randomUUID()}`;
      await mkdir(stagingDir, { recursive: true });

      try {
        await extractArchive(tmpArchive, asset.name, stagingDir);
      } catch (err) {
        await rm(stagingDir, { recursive: true, force: true });
        throw errors.backendInstallFailed(
          backend,
          `Failed to extract ${asset.name}: ${(err as Error).message}`,
        );
      }

      const staged = await findBinary(stagingDir, this.options.binaryNames ?? BINARY_NAMES[backend] ?? []);
      if (!staged) {
        await rm(stagingDir, { recursive: true, force: true });
        throw errors.backendInstallFailed(
          backend,
          `Archive ${asset.name} did not contain any of: ${(this.options.binaryNames ?? BINARY_NAMES[backend] ?? []).join(', ')}`,
        );
      }
      await chmod(staged, 0o755);

      // The binary resolves its libraries from its own directory ($ORIGIN),
      // so the runtime's files go beside it rather than in their own folder.
      if (runtime && tmpRuntime) {
        const runtimeDir = join(stagingDir, '.runtime');
        await mkdir(runtimeDir, { recursive: true });
        try {
          await extractArchive(tmpRuntime, runtime.name, runtimeDir);
          for (const file of await listFilesDeep(runtimeDir)) {
            await copyFile(file, join(dirname(staged), file.slice(file.lastIndexOf('/') + 1)));
          }
        } catch (err) {
          await rm(stagingDir, { recursive: true, force: true });
          throw errors.backendInstallFailed(
            backend,
            `Failed to extract ${runtime.name}: ${(err as Error).message}`,
          );
        }
        await rm(runtimeDir, { recursive: true, force: true });
      }

      await rm(targetDir, { recursive: true, force: true });
      await rename(stagingDir, targetDir);

      const binaryPath = staged.replace(stagingDir, targetDir);
      await stat(binaryPath);

      const receipt: InstalledBinary = {
        backend,
        binaryPath,
        tag,
        asset: asset.name,
        installedAt: new Date().toISOString(),
      };
      // Written last: its presence is what marks the install as complete.
      await writeFile(join(installDir, RECEIPT), JSON.stringify(receipt, null, 2), 'utf8');

      this.log.info({ backend, binaryPath, tag }, 'backend installed');
      return receipt;
    } finally {
      await rm(tmpArchive, { force: true }).catch(() => {});
      if (tmpRuntime) await rm(tmpRuntime, { force: true }).catch(() => {});
    }
  }

  private async download(asset: ReleaseAsset, dest: string, signal?: AbortSignal): Promise<void> {
    const { backend } = this.options;
    this.log.info({ backend, url: asset.browser_download_url }, 'downloading release archive');
    const res = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'pepper' },
      signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw errors.backendInstallFailed(
        backend,
        `Failed to download ${asset.name}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest),
    );
  }
}

/** Newest CUDA the NVIDIA driver supports, or undefined without `nvidia-smi`. */
async function driverCuda(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [], { timeout: 10_000 });
    return parseDriverCuda(stdout);
  } catch {
    return undefined;
  }
}

async function listFilesDeep(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesDeep(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function suffixOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'archive.tar.gz';
  if (lower.endsWith('.tgz')) return 'archive.tgz';
  return 'archive.zip';
}

async function extractArchive(archivePath: string, assetName: string, dest: string): Promise<void> {
  const lower = assetName.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await tar.x({ file: archivePath, cwd: dest });
    return;
  }
  new AdmZip(archivePath).extractAllTo(dest, /* overwrite */ true);
}

/** Depth-first search for the first matching executable name. */
async function findBinary(dir: string, names: string[]): Promise<string | null> {
  if (names.length === 0) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // A hit in this directory beats one further down: release archives put the
  // real binary in `build/bin/` and sometimes leave a same-named wrapper in a
  // sibling example directory.
  for (const name of names) {
    if (entries.some((e) => e.isFile() && e.name === name)) return join(dir, name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findBinary(join(dir, entry.name), names);
      if (found) return found;
    }
  }
  return null;
}
