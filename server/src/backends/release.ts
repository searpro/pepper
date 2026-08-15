import type { Accel } from '../config.js';

/**
 * Pick the right release asset for the host platform, architecture and
 * acceleration backend (requirement 6).
 *
 * Asset names embed drifting version strings, so matching is by keyword rather
 * than exact filename:
 *   sd-master-b12098f-bin-Linux-Ubuntu-24.04-x86_64.zip
 *   sd-master-b12098f-bin-Darwin-macOS-15.7.7-arm64.zip
 *   llama-b4589-bin-ubuntu-x64-cuda-12.4.zip
 *
 * `metal` is treated as macOS's *native* build rather than a keyword to match:
 * Apple builds ship Metal support compiled in and do not advertise it in the
 * filename, so looking for the literal string "metal" finds nothing and fails
 * a perfectly good install. On darwin it therefore selects the plain macOS
 * asset — the same path `cpu` takes — while still rejecting a CUDA/ROCm build
 * that happened to match the arch.
 */

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface SelectionResult {
  asset: ReleaseAsset;
  /** Why this asset was chosen — logged, and shown in the UI's backend panel. */
  reason: string;
}

const ACCEL_KEYWORDS: Record<'cuda' | 'rocm' | 'vulkan', string[]> = {
  cuda: ['cuda', 'cu12', 'cu11'],
  rocm: ['rocm', 'hip'],
  vulkan: ['vulkan'],
};

/** Any of these in a name means the asset is an accelerated/aux build. */
const ALL_ACCEL_KEYWORDS = ['cuda', 'cu12', 'cu11', 'cudart', 'rocm', 'hip', 'vulkan', 'sycl'];

const ARCHIVE_EXTS = ['.zip', '.tar.gz', '.tgz'];

function osKeywords(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case 'linux':
      return ['linux', 'ubuntu'];
    case 'darwin':
      return ['darwin', 'macos', 'apple'];
    case 'win32':
      return ['win'];
    default:
      return [];
  }
}

function archKeywords(platform: NodeJS.Platform, arch: string): string[] {
  if (platform === 'win32') return ['x64', 'x86_64', 'amd64'];
  if (arch === 'arm64') return ['arm64', 'aarch64'];
  if (arch === 'x64') return ['x86_64', 'amd64', 'x64'];
  return [arch];
}

/** Windows CPU builds come in AVX flavors; prefer the broadly-compatible avx2. */
const WIN_CPU_PREFERENCE = ['avx2', 'avx512', 'avx', 'noavx'];

export function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.some((ext) => lower.endsWith(ext));
}

export function selectAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  accel: Accel = 'cpu',
): SelectionResult {
  const os = osKeywords(platform);
  const archs = archKeywords(platform, arch);
  if (os.length === 0) throw new Error(`Unsupported platform: ${platform}`);

  const lower = (a: ReleaseAsset) => a.name.toLowerCase();

  let candidates = assets.filter((a) => {
    const n = lower(a);
    return isArchive(a.name) && os.some((k) => n.includes(k)) && archs.some((k) => n.includes(k));
  });

  // macOS assets frequently omit the arch entirely (one universal binary), so
  // retry on OS alone rather than reporting "no asset" for a release that has
  // a perfectly usable one.
  if (candidates.length === 0 && platform === 'darwin') {
    candidates = assets.filter((a) => isArchive(a.name) && os.some((k) => lower(a).includes(k)));
  }

  // The standalone CUDA redistributable is never the binary we want — it ships
  // only the runtime libraries and matches every keyword the real asset does.
  candidates = candidates.filter((a) => !lower(a).startsWith('cudart'));

  if (candidates.length === 0) {
    throw new Error(
      `No release asset found for ${platform}/${arch}. Available: ${
        assets.map((a) => a.name).join(', ') || '(none)'
      }`,
    );
  }

  // Metal and CPU both want the plain, un-accelerated build for their platform.
  if (accel === 'cpu' || accel === 'metal') {
    const plain = candidates.filter((a) => !ALL_ACCEL_KEYWORDS.some((k) => lower(a).includes(k)));
    if (plain.length > 0) candidates = plain;

    if (platform === 'win32') {
      for (const pref of WIN_CPU_PREFERENCE) {
        const match = candidates.find((a) => lower(a).includes(pref));
        if (match) return { asset: match, reason: `${accel}/${pref}` };
      }
    }
    // Otherwise the smallest, which is reliably the plain build.
    candidates.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    return { asset: candidates[0], reason: accel };
  }

  const keywords = ACCEL_KEYWORDS[accel];
  const matches = candidates.filter((a) => keywords.some((k) => lower(a).includes(k)));
  if (matches.length === 0) {
    throw new Error(
      `No "${accel}" build available for ${platform}/${arch}. Candidates: ${candidates
        .map((a) => a.name)
        .join(', ')}`,
    );
  }
  // Among several CUDA builds, the newest toolkit is the higher version
  // number; prefer it, falling back to size for ties.
  matches.sort((a, b) => cudaRank(b.name) - cudaRank(a.name) || (a.size ?? 0) - (b.size ?? 0));
  return { asset: matches[0], reason: accel };
}

/** Extract a comparable CUDA toolkit version from an asset name (`cuda-12.4` → 1204). */
function cudaRank(name: string): number {
  const m = /cu(?:da)?[-_]?(\d+)(?:[._](\d+))?/i.exec(name);
  if (!m) return 0;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  // "cu12" style has no minor and a two-digit major; normalise both forms.
  return (major > 100 ? major : major * 100) + minor;
}
