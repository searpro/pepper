import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BACKENDS, publicConfig, type BackendId } from '../config.js';
import { errors } from '../errors.js';
import { backendOverridesSchema } from '../backends/args.js';
import { ensurePythonPackageInstalled, pythonActiveModelKey } from '../backends/python.js';
import { hfWhoami, maskToken, setHfToken } from '../util/hf.js';

/**
 * System surface: health, configuration, backend lifecycle and HuggingFace
 * auth. These are the endpoints the Preferences screen is built from.
 */
export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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
      version: app.appVersion,
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
      version: app.appVersion,
      uptime: Math.round(process.uptime()),
      accel: app.config.accel,
      platform: `${process.platform}/${process.arch}`,
      backends: app.backends.statusAll(),
      // Sampled here rather than on its own poll, so the header meters and the
      // backend pills refresh together from the one request the UI already makes.
      resources: await app.resources.sample(),
      idleTimeoutMs: app.backends.idleTimeoutMs(),
      jobs: app.jobs.stats(),
      catalogue: app.catalogue.state(),
      generators: app.images.stats,
      paths: {
        dataDir: app.paths.dataDir,
        modelsDir: app.paths.modelsDir,
        outputDir: app.paths.outputDir,
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
    async () => publicConfig(app.config),
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
    async () => app.resources.sample(),
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
    async (req) => ({ idleTimeoutMs: app.backends.setIdleTimeout(req.body.idleTimeoutMs) }),
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
    async () => ({ backends: app.backends.statusAll() }),
  );

  const backendParams = z.object({ backend: z.string() });

  function parseBackend(value: string): BackendId {
    if (!(BACKENDS as readonly string[]).includes(value)) throw errors.backendNotFound(value);
    return value as BackendId;
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
    async (req) => app.backends.status(parseBackend(req.params.backend)),
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
    async (req) => app.backends.updateArgs(parseBackend(req.params.backend), req.body),
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
      const proc = await app.backends.ensureRunning(backend);
      // A skipped start (no audio models, no vLLM model selected) used to
      // answer 200 with "stopped" and no reason, which read as the button
      // doing nothing at all.
      if (!proc) {
        throw errors.backendUnavailable(
          backend,
          app.backends.status(backend).note ?? `${backend} has nothing to serve yet`,
        );
      }
      return app.backends.status(backend);
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
      await app.backends.get(backend)?.stop();
      return app.backends.status(backend);
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
      await app.backends.get(backend)?.stop();
      const proc = await app.backends.ensureRunning(backend);
      if (!proc) {
        throw errors.backendUnavailable(
          backend,
          app.backends.status(backend).note ?? `${backend} has nothing to serve yet`,
        );
      }
      return app.backends.status(backend);
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
      void app.backends
        .reinstall(backend)
        .then(async () => {
          // The runtime alone spawns nothing: whichever bundle is selected in
          // Preferences still needs its `python_package` cloned into the venv
          // before `pythonManagedValues` (the prepare hook) will let the
          // process start. Piggybacking this on the same "install" action
          // keeps the Python backend a one-click install like every other
          // backend, rather than a second, undiscoverable step.
          if (backend !== 'python') return;
          // torch, diffusers & co. for Pepper's runners, so the first video
          // job does not spend its first minutes installing them.
          await app.pythonVideo.prepare((line) => app.log.info(line));
          const modelId = app.settings.get(pythonActiveModelKey());
          if (!modelId) return;
          const bundle = await app.models.find(modelId).catch(() => null);
          if (!bundle) return;
          await ensurePythonPackageInstalled(app.backends.python, bundle.manifest);
          app.backends.scheduleRestart('python', 'model package installed');
        })
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
      const whoami = await hfWhoami(app.config.hfToken);
      return { ...whoami, token: maskToken(app.config.hfToken) };
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
