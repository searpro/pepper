import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import type { FastifyBaseLogger } from 'fastify';
import type { Accel, BackendId } from '../config.js';
import { errors } from '../errors.js';
import { isArchive, selectAsset, type ReleaseAsset } from './release.js';

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
export const BINARY_NAMES: Record<BackendId, string[]> = {
  sdcpp: ['sd-cli', 'sd-cli.exe', 'sd', 'sd.exe'],
  llamacpp: ['llama-server', 'llama-server.exe'],
  audiocpp: ['audiocpp_server', 'audiocpp_server.exe', 'audio-server', 'audio-server.exe'],
  // The Python backend is not a release archive at all — see `PythonInstaller`.
  python: [],
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
    const release = await this.latestRelease(signal);
    const { asset, reason } = selectAsset(
      release.assets ?? [],
      process.platform,
      process.arch,
      this.options.accel,
    );
    this.log.info(
      { backend: this.options.backend, tag: release.tag_name, asset: asset.name, accel: reason },
      'selected release asset',
    );
    return this.installAsset(asset, release.tag_name, signal);
  }

  async installAsset(
    asset: ReleaseAsset,
    tag: string,
    signal?: AbortSignal,
  ): Promise<InstalledBinary> {
    const { backend, installDir } = this.options;
    if (!isArchive(asset.name)) {
      throw errors.backendInstallFailed(backend, `Asset ${asset.name} is not a supported archive`);
    }

    const tmpArchive = join(tmpdir(), `pepper-${backend}-${randomUUID()}-${suffixOf(asset.name)}`);
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

    try {
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(tmpArchive),
      );

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

      const staged = await findBinary(stagingDir, BINARY_NAMES[backend]);
      if (!staged) {
        await rm(stagingDir, { recursive: true, force: true });
        throw errors.backendInstallFailed(
          backend,
          `Archive ${asset.name} did not contain any of: ${BINARY_NAMES[backend].join(', ')}`,
        );
      }
      await chmod(staged, 0o755);

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
    }
  }
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
