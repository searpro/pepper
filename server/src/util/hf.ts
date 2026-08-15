/**
 * HuggingFace access: token handling and repo listing.
 *
 * The token is attached to HuggingFace hosts only. Download URLs redirect to a
 * CDN (cdn-lfs.huggingface.co and friends) that neither needs nor should
 * receive an `Authorization` header — forwarding one across a redirect is how
 * a credential ends up in somebody else's access log.
 */

let overrideToken: string | undefined;

/** Set an in-memory token, overriding the configured one (used by the auth route). */
export function setHfToken(token: string | undefined): void {
  overrideToken = token?.trim() || undefined;
}

export function resolveHfToken(configured?: string): string | undefined {
  return overrideToken ?? configured;
}

export function isHuggingFaceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'huggingface.co' || host.endsWith('.huggingface.co');
  } catch {
    return false;
  }
}

export function hfAuthHeaders(url: string, configured?: string): Record<string, string> {
  const token = resolveHfToken(configured);
  if (!token || !isHuggingFaceUrl(url)) return {};
  return { Authorization: `Bearer ${token}` };
}

/** Never render a token in a log line or an API response. */
export function maskToken(token?: string): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function gatedHint(status: number): string {
  return status === 401
    ? 'HuggingFace rejected the request (401). This repo needs a token — set HF_TOKEN.'
    : 'HuggingFace denied access (403). This model is gated: accept its license on huggingface.co, then set HF_TOKEN to a token with access.';
}

// --- Repo file listing ------------------------------------------------------

export interface HfFile {
  /** Path within the repo. */
  path: string;
  size: number;
}

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { size?: number };
}

const treeCache = new Map<string, { at: number; files: HfFile[] }>();
const TREE_TTL_MS = 10 * 60 * 1000;

/**
 * List the files in a HuggingFace repo path. Cached, because the catalogue UI
 * asks for the same repo listing every time a user opens a model's quant
 * picker and the answer changes about as often as the model is re-uploaded.
 */
export async function listRepoFiles(
  repo: string,
  path: string | undefined,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<HfFile[]> {
  const key = `${repo}::${path ?? ''}`;
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.files;

  const url = `https://huggingface.co/api/models/${repo}/tree/main${path ? `/${path}` : ''}?recursive=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pepper', ...hfAuthHeaders(url, token) },
    signal,
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(gatedHint(res.status));
    throw new Error(`HuggingFace listing failed for ${repo}: HTTP ${res.status} ${res.statusText}`);
  }

  const entries = (await res.json()) as TreeEntry[];
  const files = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: entry.path, size: entry.lfs?.size ?? entry.size ?? 0 }));

  treeCache.set(key, { at: Date.now(), files });
  return files;
}

/** Build the resolve URL a file at `path` in `repo` downloads from. */
export function hfResolveUrl(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}?download=true`;
}

/**
 * Extract the quantization token from a weight filename, so the catalogue UI
 * can label the options a user picks between. Recognizes both the SD-style
 * (`Q4_K_M`, `BF16`, `F16`) and llama.cpp's imatrix naming (`IQ4_XS`).
 */
export function parseQuant(filename: string): string | undefined {
  const m = /(?:^|[._-])((?:I?Q\d+(?:_[A-Z0-9]+)*)|BF16|FP?16|FP?32|F16|F32|Q8_0)(?:[._-]|$)/i.exec(
    filename,
  );
  return m ? m[1].toUpperCase() : undefined;
}

/** Verify a token and report the account it belongs to. Cached briefly. */
let whoamiCache: { at: number; token: string; result: HfWhoami } | null = null;
const WHOAMI_TTL_MS = 60_000;

export interface HfWhoami {
  valid: boolean;
  name?: string;
  type?: string;
  error?: string;
}

export async function hfWhoami(token: string | undefined): Promise<HfWhoami> {
  const resolved = resolveHfToken(token);
  if (!resolved) return { valid: false, error: 'No token configured' };
  if (whoamiCache && whoamiCache.token === resolved && Date.now() - whoamiCache.at < WHOAMI_TTL_MS) {
    return whoamiCache.result;
  }

  try {
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { 'User-Agent': 'pepper', Authorization: `Bearer ${resolved}` },
      signal: AbortSignal.timeout(10_000),
    });
    let result: HfWhoami;
    if (res.ok) {
      const body = (await res.json()) as { name?: string; type?: string };
      result = { valid: true, name: body.name, type: body.type };
    } else {
      result = { valid: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    whoamiCache = { at: Date.now(), token: resolved, result };
    return result;
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}
