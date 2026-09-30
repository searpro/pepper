import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { backendOverridesSchema } from '../backends/args.js';
import type { BackendManager } from '../backends/manager.js';
import { publicConfig, type CoreConfig } from '../config.js';
import type { DownloadManager } from '../downloads/manager.js';
import type { EngineRegistry } from '../engines/engine.js';
import { errors } from '../errors.js';
import type { JobManager } from '../jobs/manager.js';
import type { Paths } from '../paths.js';
import type { ActivityTracker } from '../services/activity.js';
import type { ResourceMonitor } from '../services/resources.js';
import type { StorageMonitor } from '../services/storage.js';
import { hfWhoami, maskToken, setHfToken } from '../util/hf.js';

export interface SystemRoutesOptions {
  version: string;
  config: CoreConfig;
  paths: Paths;
  backends: BackendManager;
  engines: EngineRegistry;
  jobs: JobManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  downloads: DownloadManager<any, any>;
  resources: ResourceMonitor;
  storage: StorageMonitor;
  activity: ActivityTracker;
  /** Product work that also keeps the server from counting as idle. */
  isBusy?: () => boolean;
  /** Product fields merged into `/v1/system/status` (catalogue state, generator stats…). */
  status?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Runs after an explicitly requested install of `backend` succeeds. */
  afterInstall?: (backend: string) => Promise<void>;
}

/**
 * System surface: health, configuration, backend lifecycle and HuggingFace
 * auth. These are the endpoints the Preferences screen is built from.
 */
export async function systemRoutes(fastify: FastifyInstance, options: SystemRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { config, paths, backends, engines, jobs, downloads, resources, storage, activity } = options;

  /** Work in progress, which keeps the server from counting as idle. */
  function isBusy(): boolean {
    const queue = jobs.stats();
    return (
      queue.running + queue.queued > 0 ||
      downloads.list({ status: ['queued', 'downloading'] }).length > 0 ||
      (options.isBusy?.() ?? false)
    );
  }

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        response: {
          200: z.object({
            status: z.literal('ok'),
            uptime: z.number(),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptime: Math.round(process.uptime()),
      version: options.version,
    }),
  );

  /**
   * Readiness, as distinct from liveness: which backends are actually usable
   * right now. A deployment probe wants `/health`; a UI wants this.
   */
  app.get(
    '/v1/system/status',
    {
      schema: {
        tags: ['system'],
        summary: 'Backend, queue and catalogue status',
        response: { 200: z.unknown() },
      },
    },
    async () => ({
      version: options.version,
      uptime: Math.round(process.uptime()),
      accel: config.accel,
      platform: `${process.platform}/${process.arch}`,
      backends: backends.statusAll(),
      engines: engines.status(),
      // Sampled here rather than on its own poll, so the header meters and the
      // backend pills refresh together from the one request the UI already makes.
      resources: await resources.sample(),
      // Only where the volume's size is configured; see services/storage.ts.
      storage: storage.snapshot(),
      idleTimeoutMs: backends.idleTimeoutMs(),
      jobs: jobs.stats(),
      activity: activity.snapshot(isBusy()),
      ...(await options.status?.()),
      paths: {
        dataDir: paths.dataDir,
        modelsDir: paths.modelsDir,
        outputDir: paths.outputDir,
      },
    }),
  );

  app.get(
    '/v1/config',
    {
      schema: {
        tags: ['system'],
        summary: 'Effective configuration (secrets redacted)',
        response: { 200: z.unknown() },
      },
    },
    async () => publicConfig(config),
  );

  app.get(
    '/v1/system/resources',
    {
      schema: {
        tags: ['system'],
        summary: 'CPU, RAM, GPU and GPU-memory utilisation of the host',
        response: { 200: z.unknown() },
      },
    },
    async () => resources.sample(),
  );

  // --- Backends -------------------------------------------------------------

  app.put(
    '/v1/backends/idle-timeout',
    {
      schema: {
        tags: ['backends'],
        summary: 'Set how long an unused backend stays running',
        description:
          'Backends start on the first job that needs them and stop after this long with ' +
          'nothing using them. 0 keeps them running; null reverts to BACKEND_IDLE_TIMEOUT.',
        body: z.object({ idleTimeoutMs: z.number().int().min(0).nullable() }),
        response: { 200: z.object({ idleTimeoutMs: z.number() }) },
      },
    },
    async (req) => ({ idleTimeoutMs: backends.setIdleTimeout(req.body.idleTimeoutMs) }),
  );

  app.get(
    '/v1/backends',
    {
      schema: {
        tags: ['backends'],
        summary: 'List backends with their status and effective CLI arguments',
        response: { 200: z.object({ backends: z.array(z.unknown()) }) },
      },
    },
    async () => ({ backends: backends.statusAll() }),
  );

  const backendParams = z.object({ backend: z.string() });

  function parseBackend(value: string): string {
    if (!backends.has(value)) throw errors.backendNotFound(value);
    return value;
  }

  app.get(
    '/v1/backends/:backend',
    {
      schema: {
        tags: ['backends'],
        summary: 'One backend',
        params: backendParams,
        response: { 200: z.unknown() },
      },
    },
    async (req) => backends.status(parseBackend(req.params.backend)),
  );

  app.put(
    '/v1/backends/:backend/args',
    {
      schema: {
        tags: ['backends'],
        summary: 'Replace a backend’s CLI arguments',
        description:
          'Persisted to the database and applied on the next start. A running backend is ' +
          'restarted so the change takes effect immediately.',
        params: backendParams,
        body: backendOverridesSchema,
        response: { 200: z.unknown() },
      },
    },
    async (req) => backends.updateArgs(parseBackend(req.params.backend), req.body),
  );

  app.post(
    '/v1/backends/:backend/start',
    {
      schema: {
        tags: ['backends'],
        summary: 'Start a backend',
        params: backendParams,
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const backend = parseBackend(req.params.backend);
      const proc = await backends.ensureRunning(backend);
      // A skipped start (no audio models, no vLLM model selected) used to
      // answer 200 with "stopped" and no reason, which read as the button
      // doing nothing at all.
      if (!proc) {
        throw errors.backendUnavailable(
          backend,
          backends.status(backend).note ?? `${backend} has nothing to serve yet`,
        );
      }
      return backends.status(backend);
    },
  );

  app.post(
    '/v1/backends/:backend/stop',
    {
      schema: {
        tags: ['backends'],
        summary: 'Stop a backend',
        params: backendParams,
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const backend = parseBackend(req.params.backend);
      await backends.get(backend)?.stop();
      return backends.status(backend);
    },
  );

  app.post(
    '/v1/backends/:backend/restart',
    {
      schema: {
        tags: ['backends'],
        summary: 'Restart a backend',
        params: backendParams,
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const backend = parseBackend(req.params.backend);
      // Stop then start through the manager rather than `proc.restart()`, so
      // the argv and registry are regenerated (a model installed since the
      // last start is picked up) and a skip is reported like `start` does.
      await backends.get(backend)?.stop();
      const proc = await backends.ensureRunning(backend);
      if (!proc) {
        throw errors.backendUnavailable(
          backend,
          backends.status(backend).note ?? `${backend} has nothing to serve yet`,
        );
      }
      return backends.status(backend);
    },
  );

  app.post(
    '/v1/backends/:backend/install',
    {
      schema: {
        tags: ['backends'],
        summary: 'Install (or reinstall) the latest release of a backend',
        params: backendParams,
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const backend = parseBackend(req.params.backend);
      // Installs run for minutes and pull gigabytes; holding the request open
      // would hit every proxy timeout between here and the browser. The UI
      // follows progress through the log stream instead.
      void backends
        .reinstall(backend)
        .then(() => options.afterInstall?.(backend))
        .catch((err) => {
          app.log.error({ backend, err: (err as Error).message }, 'backend install failed');
        });
      return reply.code(202).send({ backend, status: 'installing' });
    },
  );

  // --- HuggingFace auth -----------------------------------------------------

  app.get(
    '/v1/auth/hf',
    {
      schema: {
        tags: ['system'],
        summary: 'HuggingFace token status',
        response: { 200: z.unknown() },
      },
    },
    async () => {
      const whoami = await hfWhoami(config.hfToken);
      return { ...whoami, token: maskToken(config.hfToken) };
    },
  );

  app.post(
    '/v1/auth/hf/verify',
    {
      schema: {
        tags: ['system'],
        summary: 'Verify a HuggingFace token',
        description:
          'Validates the supplied token and, if it works, keeps it in memory for this process. ' +
          'It is never persisted — HF_TOKEN remains the durable configuration.',
        body: z.object({ token: z.string().min(1) }),
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const result = await hfWhoami(req.body.token);
      if (result.valid) setHfToken(req.body.token);
      return { ...result, token: maskToken(req.body.token) };
    },
  );
}
