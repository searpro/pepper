import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Configuration shared by every product built on the core (requirement 9).
 *
 * Everything is environment-driven — there is no config file tier the way
 * sd-api had one. Two reasons: the production surface is a container where
 * env vars are the only injection point anyway, and a single source means a
 * setting can never disagree with itself depending on which layer you read.
 * Runtime-mutable preferences (backend CLI args, generation defaults) live in
 * SQLite instead, so they survive a restart without being baked into the
 * image — see `db/settings.ts`.
 *
 * `DATA_DIR` is the one path that matters: everything the app persists is
 * derived from it (see `paths.ts`), because in production it is a mounted
 * persistent volume and anything written outside it is lost on redeploy.
 *
 * A product extends `CoreConfig` with its own fields and spreads
 * `loadCoreConfig(env)` into its own loader.
 */

export type Accel = 'cpu' | 'cuda' | 'metal' | 'vulkan' | 'rocm';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CoreConfig {
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
  /** How long to wait for a persistent backend's health endpoint at startup. */
  backendStartupTimeoutMs: number;
  /**
   * Stop a persistent backend after it has served nothing for this long; 0
   * keeps it running. Backends start on demand, so the cost of stopping is a
   * model load on the next job. Preferences can override it at runtime.
   */
  backendIdleTimeoutMs: number;
  /**
   * The size of the volume behind `DATA_DIR`, in GB, when the filesystem does
   * not report it: a RunPod network volume is a quota that `statfs` cannot
   * see. Set, downloads that would not fit are refused up front
   * (services/storage.ts). Unset, there is no check.
   */
  dataVolumeGb?: number;

  // --- Work limits ---
  maxConcurrentJobs: number;
  maxConcurrentDownloads: number;

  // --- Catalogue ---
  /** The remote catalogue manifest this product installs from. */
  catalogueUrl: string;
  /** How long a fetched catalogue is served before it is refetched. */
  catalogueTtlMs: number;

  // --- Credentials ---
  /** HuggingFace token for gated/private repos. Never logged or echoed. */
  hfToken?: string;
  /**
   * Shared secret every API, MCP and docs request must present (see
   * `auth.ts`). Unset leaves the server open, which is what local
   * development expects; any deployment reachable from the internet must
   * set it.
   */
  apiToken?: string;
}

/**
 * Timeout defaults carried over from sd-api's working configuration, so a
 * deployment that sets none of these behaves exactly like the POC did.
 */
export const CORE_DEFAULTS = {
  backendStartupTimeoutMs: 30_000, // sd-api {llm,audio}_startup_timeout_ms
  backendIdleTimeoutMs: 5 * 60 * 1000,
  httpServerTimeoutMs: 0, // Fastify default: no request timeout
  maxConcurrentJobs: 1, // sd-api max_concurrent_jobs
  maxConcurrentDownloads: 2, // sd-api max_concurrent_downloads
  outputRetentionMs: 24 * 60 * 60 * 1000,
  catalogueTtlMs: 10 * 60 * 1000,
} as const;

const accelSchema = z.enum(['cpu', 'cuda', 'metal', 'vulkan', 'rocm']);
const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const repoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"');

export function num(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric, got "${value}"`);
  return n;
}

export function positiveNum(name: string, value: string | undefined, fallback: number): number {
  const n = num(name, value, fallback);
  if (n <= 0) throw new Error(`${name} must be greater than 0, got ${n}`);
  return n;
}

export function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be a boolean, got "${value}"`);
}

export function enumOf<T extends string>(
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

export function repo(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = repoSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error(`${name} must look like "owner/repo", got "${value}"`);
  return parsed.data;
}

/** Absolute path, expanding a leading `~`. Relative paths resolve against cwd. */
export function path(value: string): string {
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/** The platform's natural acceleration, used when `ACCEL` is unset. */
function defaultAccel(platform: NodeJS.Platform = process.platform): Accel {
  return platform === 'darwin' ? 'metal' : 'cpu';
}

export interface CoreConfigDefaults {
  /** Output directory name under the OS temp dir. */
  outputDirName: string;
  catalogueUrl: string;
}

export function loadCoreConfig(env: NodeJS.ProcessEnv, defaults: CoreConfigDefaults): CoreConfig {
  const dataDir = path(env.DATA_DIR?.trim() || './data');

  return {
    dataDir,
    outputDir: path(env.OUTPUT_DIR?.trim() || join(tmpdir(), defaults.outputDirName)),
    outputRetentionMs: num('OUTPUT_RETENTION_MS', env.OUTPUT_RETENTION_MS, CORE_DEFAULTS.outputRetentionMs),

    host: env.HOST?.trim() || '0.0.0.0',
    port: positiveNum('PORT', env.PORT, 3000),
    httpServerTimeoutMs: num('HTTP_SERVER_TIMEOUT', env.HTTP_SERVER_TIMEOUT, CORE_DEFAULTS.httpServerTimeoutMs),
    logLevel: enumOf('LOG_LEVEL', logLevelSchema, env.LOG_LEVEL, 'info'),

    accel: enumOf('ACCEL', accelSchema, env.ACCEL, defaultAccel()),
    autoInstallBackends: bool('AUTO_INSTALL_BACKENDS', env.AUTO_INSTALL_BACKENDS, true),
    backendStartupTimeoutMs: positiveNum(
      'BACKEND_STARTUP_TIMEOUT',
      env.BACKEND_STARTUP_TIMEOUT,
      CORE_DEFAULTS.backendStartupTimeoutMs,
    ),
    backendIdleTimeoutMs: num(
      'BACKEND_IDLE_TIMEOUT',
      env.BACKEND_IDLE_TIMEOUT,
      CORE_DEFAULTS.backendIdleTimeoutMs,
    ),
    dataVolumeGb: env.DATA_VOLUME_GB?.trim() ? positiveNum('DATA_VOLUME_GB', env.DATA_VOLUME_GB, 0) : undefined,

    maxConcurrentJobs: positiveNum('MAX_CONCURRENT_JOBS', env.MAX_CONCURRENT_JOBS, CORE_DEFAULTS.maxConcurrentJobs),
    maxConcurrentDownloads: positiveNum(
      'MAX_CONCURRENT_DOWNLOADS',
      env.MAX_CONCURRENT_DOWNLOADS,
      CORE_DEFAULTS.maxConcurrentDownloads,
    ),

    catalogueUrl: env.CATALOGUE_URL?.trim() || defaults.catalogueUrl,
    catalogueTtlMs: positiveNum('CATALOGUE_TTL_MS', env.CATALOGUE_TTL_MS, CORE_DEFAULTS.catalogueTtlMs),

    hfToken: env.HF_TOKEN?.trim() || env.HUGGING_FACE_HUB_TOKEN?.trim() || undefined,
    apiToken: env.PEPPER_API_TOKEN?.trim() || undefined,
  };
}

/**
 * Config as it is safe to hand to the UI: same shape, minus anything secret.
 * `hfToken` and `apiToken` are replaced by booleans — the UI only ever needs to
 * know whether a token is configured, never what it is.
 */
export function publicConfig(config: CoreConfig): Record<string, unknown> {
  const { hfToken, apiToken, ...rest } = config;
  return { ...rest, hfTokenConfigured: Boolean(hfToken), apiTokenConfigured: Boolean(apiToken) };
}
