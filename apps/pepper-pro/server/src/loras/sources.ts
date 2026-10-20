import { basename } from 'node:path';
import { errors } from '@pepper/core/errors.js';
import { civitaiAuthHeaders } from '@pepper/core/util/civitai.js';
import { hfAuthHeaders } from '@pepper/core/util/hf.js';
import { guessBase, type LoraBaseId } from './bases.js';

/**
 * What a link to a LoRA turns out to be: the file to download and what its
 * source says about it. A Civitai page or a HuggingFace repository is looked
 * up through the site's API, so the trigger words, base model and size come
 * with it; any other link is taken as the file itself.
 *
 * Only `.safetensors` is accepted. A pickled `.pt` or `.ckpt` runs code when
 * it is loaded, and a LoRA from an arbitrary link must not be able to.
 */

export type LoraSource = 'huggingface' | 'civitai' | 'url';

export interface LoraCandidate {
  source: LoraSource;
  /** What the file downloads from. */
  url: string;
  /** Proposed name on disk. */
  file: string;
  /** The file as the source names it, which `choices` lists and `file` in a request picks. */
  source_file: string;
  /** Proposed display name. */
  name: string;
  page_url?: string;
  /** The base model as the source names it. */
  source_base?: string;
  /** The library's base the source seems to mean, for the person adding it to confirm. */
  base?: LoraBaseId;
  trigger_words: string[];
  description?: string;
  preview_url?: string;
  bytes?: number;
  sha256?: string;
  /** A repository with several LoRA files: each one, to pick from with `file`. */
  choices?: { file: string; bytes?: number }[];
}

export interface LookupOptions {
  /** Which file of a repository with several. */
  file?: string;
  hfToken?: string;
  civitaiToken?: string;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 20_000;

export async function lookupLora(link: string, options: LookupOptions = {}): Promise<LoraCandidate> {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw errors.validation(`"${link}" is not a link`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw errors.validation('A LoRA link must be http or https');
  const host = url.hostname.toLowerCase();
  if (host === 'civitai.com' || host.endsWith('.civitai.com')) return civitai(url, options);
  if (host === 'huggingface.co' || host === 'hf.co') return huggingface(url, options);
  return direct(url, options);
}

async function getJson<T>(url: string, headers: Record<string, string>, options: LookupOptions, what: string): Promise<T> {
  const res = await (options.fetch ?? fetch)(url, {
    headers: { 'User-Agent': 'pepper-pro', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw errors.validation(`${what} refused the lookup (${res.status}); it may need a token (HF_TOKEN or CIVITAI_TOKEN)`);
  }
  if (res.status === 404) throw errors.validation(`${what} has no such model`);
  if (!res.ok) throw errors.validation(`${what} lookup failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function safetensorsName(name: string): string {
  const clean = basename(name).replace(/[^\w.+-]+/g, '_');
  if (!/\.safetensors$/i.test(clean)) throw errors.validation(`"${name}" is not a .safetensors file; only .safetensors LoRAs are accepted`);
  return clean;
}

function plainText(html: string | undefined, max = 600): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Trigger words as sources write them: one per entry, or several
 * comma-separated in one ("filmgrain, analog photo"). An entry that is a
 * sentence (an edit LoRA's instruction) stays whole, commas and all.
 */
function words(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const all = list.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const pieces = entry.split(',').map((w) => w.trim());
    return pieces.every((piece) => piece.split(/\s+/).length <= 4) ? pieces : [entry.trim()];
  });
  return [...new Set(all.filter(Boolean))].slice(0, 20);
}

// --- Civitai -------------------------------------------------------------------

interface CivitaiFile {
  name: string;
  type?: string;
  sizeKB?: number;
  primary?: boolean;
  downloadUrl: string;
  hashes?: { SHA256?: string };
}

interface CivitaiVersion {
  id: number;
  modelId?: number;
  name?: string;
  baseModel?: string;
  trainedWords?: string[];
  description?: string;
  files?: CivitaiFile[];
  images?: { url: string; type?: string; nsfwLevel?: number }[];
  model?: { name?: string; type?: string };
}

interface CivitaiModel {
  id: number;
  name: string;
  type?: string;
  description?: string;
  modelVersions?: CivitaiVersion[];
}

const LORA_TYPES = new Set(['LORA', 'LOCON', 'DORA', 'LYCORIS']);

async function civitai(url: URL, options: LookupOptions): Promise<LoraCandidate> {
  const api = 'https://civitai.com/api/v1';
  const auth = civitaiAuthHeaders(api, options.civitaiToken);
  // A version is named by `?modelVersionId=` on a page, or is the id in a download link.
  const download = /^\/api\/download\/models\/(\d+)/.exec(url.pathname);
  const page = /^\/models\/(\d+)/.exec(url.pathname);
  const versionId = download?.[1] ?? url.searchParams.get('modelVersionId') ?? undefined;
  if (!versionId && !page) throw errors.validation('Give a Civitai model page (civitai.com/models/…) or a download link');

  let model: { id?: number; name?: string; type?: string; description?: string } = {};
  let version: CivitaiVersion | undefined;
  if (versionId) {
    version = await getJson<CivitaiVersion>(`${api}/model-versions/${versionId}`, auth, options, 'Civitai');
    model = { id: version.modelId, name: version.model?.name, type: version.model?.type };
  } else {
    const found = await getJson<CivitaiModel>(`${api}/models/${page![1]}`, auth, options, 'Civitai');
    model = found;
    version = found.modelVersions?.[0];
  }
  if (!version) throw errors.validation('That Civitai model has no versions');
  if (model.type && !LORA_TYPES.has(model.type.toUpperCase())) {
    throw errors.validation(`That Civitai model is a ${model.type}, not a LoRA`);
  }

  const files = (version.files ?? []).filter((f) => /\.safetensors$/i.test(f.name) && (!f.type || f.type === 'Model'));
  const file = files.find((f) => f.name === options.file) ?? files.find((f) => f.primary) ?? files[0];
  if (!file) throw errors.validation('That Civitai version has no .safetensors file');
  const preview = version.images?.find((image) => (image.type ?? 'image') === 'image' && (image.nsfwLevel ?? 1) <= 1);
  const modelName = model.name ?? file.name.replace(/\.safetensors$/i, '');
  const versionName = version.name && !/^v?1(\.0)?$/i.test(version.name) ? ` (${version.name})` : '';
  return {
    source: 'civitai',
    url: file.downloadUrl,
    file: safetensorsName(file.name),
    source_file: file.name,
    name: `${modelName}${versionName}`,
    page_url: `https://civitai.com/models/${model.id ?? version.modelId ?? ''}?modelVersionId=${version.id}`,
    source_base: version.baseModel,
    base: guessBase(version.baseModel, modelName, file.name),
    trigger_words: words(version.trainedWords),
    description: plainText(version.description) ?? plainText(model.description),
    preview_url: preview?.url,
    bytes: file.sizeKB ? Math.round(file.sizeKB * 1024) : undefined,
    sha256: file.hashes?.SHA256?.toLowerCase(),
    choices: files.length > 1 ? files.map((f) => ({ file: f.name, bytes: f.sizeKB ? Math.round(f.sizeKB * 1024) : undefined })) : undefined,
  };
}

// --- HuggingFace ---------------------------------------------------------------

interface HfModelInfo {
  id: string;
  cardData?: { base_model?: string | string[]; instance_prompt?: string; widget?: { text?: string }[] };
  tags?: string[];
  siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[];
}

const GENERIC_FILE = /^(pytorch_lora_weights|adapter_model|diffusion_pytorch_model|model|lora)\.safetensors$/i;

async function huggingface(url: URL, options: LookupOptions): Promise<LoraCandidate> {
  // /owner/repo, /owner/repo/tree/<rev>/<dir>, /owner/repo/(blob|resolve)/<rev>/<path>
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw errors.validation('Give a HuggingFace repository or file link');
  const repo = `${parts[0]}/${parts[1]}`;
  const [kind, revision = 'main', ...rest] = parts.slice(2);
  const named = kind === 'blob' || kind === 'resolve' ? rest.join('/') : undefined;
  const dir = kind === 'tree' ? rest.join('/') : undefined;

  const api = `https://huggingface.co/api/models/${repo}?blobs=true`;
  const info = await getJson<HfModelInfo>(api, hfAuthHeaders(api, options.hfToken), options, 'HuggingFace');
  const files = (info.siblings ?? []).filter(
    (s) => /\.safetensors$/i.test(s.rfilename) && (!dir || s.rfilename.startsWith(`${dir}/`)),
  );
  const wanted = named ?? options.file;
  const file = wanted ? files.find((f) => f.rfilename === wanted) : files.length === 1 ? files[0] : undefined;
  if (wanted && !file) throw errors.validation(`${repo} has no .safetensors file "${wanted}"`);
  if (files.length === 0) throw errors.validation(`${repo} has no .safetensors files`);

  const bases = [info.cardData?.base_model ?? []].flat();
  const baseTags = (info.tags ?? []).filter((t) => t.startsWith('base_model:')).map((t) => t.split(':').pop()!);
  const chosen = file ?? files.reduce((a, b) => ((a.lfs?.size ?? a.size ?? 0) <= (b.lfs?.size ?? b.size ?? 0) ? a : b));
  const triggers = words(info.cardData?.instance_prompt ? [info.cardData.instance_prompt] : []);
  return {
    source: 'huggingface',
    url: `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${chosen.rfilename.split('/').map(encodeURIComponent).join('/')}`,
    // Diffusers names every LoRA `pytorch_lora_weights`; on disk it takes the repository's name.
    file: safetensorsName(GENERIC_FILE.test(basename(chosen.rfilename)) ? `${parts[1]}.safetensors` : chosen.rfilename),
    source_file: chosen.rfilename,
    name: parts[1].replace(/[-_]+/g, ' '),
    page_url: `https://huggingface.co/${repo}`,
    source_base: bases[0] ?? baseTags[0],
    base: guessBase(...bases, ...baseTags, repo, chosen.rfilename),
    trigger_words: triggers,
    bytes: chosen.lfs?.size ?? chosen.size,
    sha256: chosen.lfs?.sha256,
    // Several files: the one chosen above, and the others to pick instead.
    choices: files.length > 1 ? files.map((f) => ({ file: f.rfilename, bytes: f.lfs?.size ?? f.size })) : undefined,
  };
}

// --- Any other link ------------------------------------------------------------

async function direct(url: URL, options: LookupOptions): Promise<LoraCandidate> {
  const name = options.file ?? decodeURIComponent(url.pathname.split('/').pop() ?? '');
  const file = safetensorsName(name);
  let bytes: number | undefined;
  try {
    const res = await (options.fetch ?? fetch)(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'pepper-pro' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const length = Number(res.headers.get('content-length'));
    if (res.ok && length > 0) bytes = length;
  } catch {
    // Some hosts refuse HEAD; the download learns the size itself.
  }
  return {
    source: 'url',
    url: url.toString(),
    file,
    source_file: name,
    name: file.replace(/\.safetensors$/i, '').replace(/[-_]+/g, ' '),
    base: guessBase(file),
    trigger_words: [],
    bytes,
  };
}
