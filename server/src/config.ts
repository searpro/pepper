import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuration (requirement 9).
 *
 * Everything is environment-driven — there is no config file tier the way
 * sd-api had one. Two reasons: the production surface is a container where
 * env vars are the only injection point anyway, and a single source means a
 * setting can never disagree with itself depending on which layer you read.
 * Runtime-mutable preferences (backend CLI args, generation defaults) live in
 * SQLite instead, so they survive a restart without being baked into the
 * image — see `src/db/settings.ts`.
 *
 * `DATA_DIR` is the one path that matters: everything the app persists is
 * derived from it (see `src/paths.ts`), because in production it is a mounted
 * persistent volume and anything written outside it is lost on redeploy.
 */

export type Accel = 'cpu' | 'cuda' | 'metal' | 'vulkan' | 'rocm';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Backends the process/binary managers know how to install and supervise. */
export const BACKENDS = ['sdcpp', 'llamacpp', 'audiocpp', 'python', 'vllm'] as const;
export type BackendId = (typeof BACKENDS)[number];

export interface Config {
  // --- Storage ---
  /**
   * Root of everything the app persists (binaries, models, uploads, database).
   * Mounts a persistent volume in production.
   */
  dataDir: string;
  /**
   * Where generation outputs are written.
   *
   * Defaults *outside* `DATA_DIR` (to the OS temp dir) on purpose: outputs are
   * the one category that grows without bound — every image, video and audio
   * clip ever produced, nearly all of them fetched once by the client and
   * never read again — and persistent-volume storage is the expensive kind.
   * The client owns durable storage; the API serves `/v1/outputs/:name` for as
   * long as the file lives, and `outputRetentionMs` sweeps the rest. Point
   * this inside `DATA_DIR` if you want outputs to survive a restart.
   */
  outputDir: string;
  /** How long an output file is kept before the retention sweep removes it (0 disables the sweep). */
  outputRetentionMs: number;

  // --- Server ---
  host: string;
  port: number;
  /**
   * Per-request ceiling for the public HTTP server (0 disables it, which is
   * Fastify's own default). Synchronous generation requests can legitimately
   * run for minutes, so a timeout here has to be opt-in rather than assumed.
   */
  httpServerTimeoutMs: number;
  logLevel: LogLevel;

  // --- Backends ---
  /** Hardware acceleration to select release assets for and to pass through to backends. */
  accel: Accel;
  /** Install missing backend binaries at startup. */
  autoInstallBackends: boolean;
  /** "owner/repo" whose *latest* release is installed, per backend. */
  releaseRepos: Record<BackendId, string>;

  /** Hard ceiling on one sd-cli image generation. */
  sdcppTimeoutMs: number;
  /**
   * Hard ceiling on one sd-cli *video* generation. Video runs an order of
   * magnitude longer than an image, so it gets its own budget rather than
   * forcing `sdcppTimeoutMs` up for everything.
   */
  sdcppVideoTimeoutMs: number;
  /** Ceiling on one proxied audio request. */
  audiocppTimeoutMs: number;
  /** Ceiling on one proxied LLM completion. */
  llamacppTimeoutMs: number;
  /** How long to wait for a persistent backend's health endpoint at startup. */
  backendStartupTimeoutMs: number;

  /** Loopback ports the persistent backends listen on. Never public. */
  llamacppPort: number;
  audiocppPort: number;
  pythonPort: number;
  vllmPort: number;

  // --- Work limits ---
  maxConcurrentJobs: number;
  maxConcurrentDownloads: number;

  // --- Catalogue ---
  /** Remote `pepper-catalogue.json` — the single manifest for every model kind. */
  catalogueUrl: string;
  /** How long a fetched catalogue is served before it is refetched. */
  catalogueTtlMs: number;

  // --- Credentials ---
  /** HuggingFace token for gated/private repos. Never logged or echoed. */
  hfToken?: string;
}

const DEFAULT_RELEASE_REPOS: Record<BackendId, string> = {
  sdcpp: 'searpro/stable-diffusion.cpp',
  llamacpp: 'ggml-org/llama.cpp',
  audiocpp: 'searpro/audio.cpp',
  // No fork exists yet — the Python backend installs a runtime rather than a
  // release archive, and this is the hook for wherever that eventually lives.
  python: 'comfyanonymous/ComfyUI',
  // Unused: vLLM is baked into the production image (see Dockerfile) rather
  // than installed from a GitHub release. Kept only so `Record<BackendId, string>`
  // stays total; `BackendManager` never reads it for this backend.
  vllm: 'vllm-project/vllm-omni',
};

/**
 * Timeout defaults carried over from sd-api's working configuration, so a
 * deployment that sets none of these behaves exactly like the POC did.
 */
const DEFAULTS = {
  sdcppTimeoutMs: 600_000, // sd-api job_timeout_ms
  sdcppVideoTimeoutMs: 3_600_000, // sd-api video_job_timeout_ms
  audiocppTimeoutMs: 300_000, // sd-api audio_request_timeout_ms
  llamacppTimeoutMs: 300_000, // sd-api llm_request_timeout_ms
  backendStartupTimeoutMs: 30_000, // sd-api {llm,audio}_startup_timeout_ms
  httpServerTimeoutMs: 0, // Fastify default: no request timeout
  maxConcurrentJobs: 1, // sd-api max_concurrent_jobs
  maxConcurrentDownloads: 2, // sd-api max_concurrent_downloads
  outputRetentionMs: 24 * 60 * 60 * 1000,
  catalogueTtlMs: 10 * 60 * 1000,
  llamacppPort: 8090,
  audiocppPort: 8091,
  pythonPort: 8092,
  vllmPort: 8093,
} as const;

const accelSchema = z.enum(['cpu', 'cuda', 'metal', 'vulkan', 'rocm']);
const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const repoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"');

function num(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric, got "${value}"`);
  return n;
}

function positiveNum(name: string, value: string | undefined, fallback: number): number {
  const n = num(name, value, fallback);
  if (n <= 0) throw new Error(`${name} must be greater than 0, got ${n}`);
  return n;
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be a boolean, got "${value}"`);
}

function enumOf<T extends string>(
  name: string,
  schema: z.ZodType<T>,
  value: string | undefined,
  fallback: T,
): T {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = schema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new Error(`${name} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown value'}`);
  }
  return parsed.data;
}

function repo(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = repoSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error(`${name} must look like "owner/repo", got "${value}"`);
  return parsed.data;
}

/** Absolute path, expanding a leading `~`. Relative paths resolve against cwd. */
function path(value: string): string {
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/** The platform's natural acceleration, used when `ACCEL` is unset. */
function defaultAccel(platform: NodeJS.Platform = process.platform): Accel {
  return platform === 'darwin' ? 'metal' : 'cpu';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path(env.DATA_DIR?.trim() || './data');

  return {
    dataDir,
    outputDir: path(env.OUTPUT_DIR?.trim() || join(tmpdir(), 'pepper-outputs')),
    outputRetentionMs: num('OUTPUT_RETENTION_MS', env.OUTPUT_RETENTION_MS, DEFAULTS.outputRetentionMs),

    host: env.HOST?.trim() || '0.0.0.0',
    port: positiveNum('PORT', env.PORT, 3000),
    httpServerTimeoutMs: num('HTTP_SERVER_TIMEOUT', env.HTTP_SERVER_TIMEOUT, DEFAULTS.httpServerTimeoutMs),
    logLevel: enumOf('LOG_LEVEL', logLevelSchema, env.LOG_LEVEL, 'info'),

    accel: enumOf('ACCEL', accelSchema, env.ACCEL, defaultAccel()),
    autoInstallBackends: bool('AUTO_INSTALL_BACKENDS', env.AUTO_INSTALL_BACKENDS, true),
    releaseRepos: {
      sdcpp: repo('SDCPP_RELEASE_REPO', env.SDCPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.sdcpp),
      llamacpp: repo('LLAMACPP_RELEASE_REPO', env.LLAMACPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.llamacpp),
      audiocpp: repo('AUDIOCPP_RELEASE_REPO', env.AUDIOCPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.audiocpp),
      python: repo('PYTHON_RELEASE_REPO', env.PYTHON_RELEASE_REPO, DEFAULT_RELEASE_REPOS.python),
      vllm: DEFAULT_RELEASE_REPOS.vllm,
    },

    sdcppTimeoutMs: positiveNum('SDCPP_TIMEOUT', env.SDCPP_TIMEOUT, DEFAULTS.sdcppTimeoutMs),
    sdcppVideoTimeoutMs: positiveNum(
      'SDCPP_VIDEO_TIMEOUT',
      env.SDCPP_VIDEO_TIMEOUT,
      DEFAULTS.sdcppVideoTimeoutMs,
    ),
    audiocppTimeoutMs: num('AUDIOCPP_TIMEOUT', env.AUDIOCPP_TIMEOUT, DEFAULTS.audiocppTimeoutMs),
    llamacppTimeoutMs: num('LLAMACPP_TIMEOUT', env.LLAMACPP_TIMEOUT, DEFAULTS.llamacppTimeoutMs),
    backendStartupTimeoutMs: positiveNum(
      'BACKEND_STARTUP_TIMEOUT',
      env.BACKEND_STARTUP_TIMEOUT,
      DEFAULTS.backendStartupTimeoutMs,
    ),

    llamacppPort: positiveNum('LLAMACPP_PORT', env.LLAMACPP_PORT, DEFAULTS.llamacppPort),
    audiocppPort: positiveNum('AUDIOCPP_PORT', env.AUDIOCPP_PORT, DEFAULTS.audiocppPort),
    pythonPort: positiveNum('PYTHON_PORT', env.PYTHON_PORT, DEFAULTS.pythonPort),
    vllmPort: positiveNum('VLLM_PORT', env.VLLM_PORT, DEFAULTS.vllmPort),

    maxConcurrentJobs: positiveNum('MAX_CONCURRENT_JOBS', env.MAX_CONCURRENT_JOBS, DEFAULTS.maxConcurrentJobs),
    maxConcurrentDownloads: positiveNum(
      'MAX_CONCURRENT_DOWNLOADS',
      env.MAX_CONCURRENT_DOWNLOADS,
      DEFAULTS.maxConcurrentDownloads,
    ),

    catalogueUrl:
      env.CATALOGUE_URL?.trim() ||
      'https://raw.githubusercontent.com/searpro/pepper-catalogue/main/pepper-catalogue.json',
    catalogueTtlMs: positiveNum('CATALOGUE_TTL_MS', env.CATALOGUE_TTL_MS, DEFAULTS.catalogueTtlMs),

    hfToken: env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim() || undefined,
  };
}

/**
 * Config as it is safe to hand to the UI: same shape, minus anything secret.
 * `hfToken` is replaced by a boolean — the UI only ever needs to know whether
 * a token is configured, never what it is.
 */
export function publicConfig(config: Config): Record<string, unknown> {
  const { hfToken, ...rest } = config;
  return { ...rest, hfTokenConfigured: Boolean(hfToken) };
}
