import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { authRoutes, redactTokenPath, registerAuthHook } from './auth.js';
import { buildPaths, ensureDirs } from './paths.js';
import { openDb, type Db } from './db/client.js';
import { SettingsStore } from './db/settings.js';
import { LogBuffer } from './logs/buffer.js';
import { BackendManager } from './backends/manager.js';
import { vllmActiveModelKey, vllmManagedValues } from './backends/vllm.js';
import { pythonActiveModelKey, pythonManagedValues } from './backends/python.js';
import { ModelManager } from './models/manager.js';
import { CatalogueManager } from './catalogue/manager.js';
import { DownloadManager } from './downloads/manager.js';
import { SnapshotDownloader } from './downloads/snapshot.js';
import { JobManager } from './jobs/manager.js';
import { EngineRegistry } from './engines/engine.js';
import { createPepperEngines } from './engines/pepper.js';
import { ImageService } from './services/image.js';
import { UpscaleService } from './services/upscale.js';
import { PythonVideoService } from './services/python-video.js';
import { writeAudioServerConfig } from './services/audio-config.js';
import { writeLlmScanDir } from './services/llm-scan-dir.js';
import { AudioService } from './services/audio-gen.js';
import { TextService } from './services/text-gen.js';
import { CharacterService } from './services/characters.js';
import { ResourceMonitor } from './services/resources.js';
import { StorageMonitor } from './services/storage.js';
import { ActivityTracker, isActivity } from './services/activity.js';
import { systemRoutes } from './routes/system.js';
import { modelRoutes } from './routes/models.js';
import { downloadRoutes } from './routes/downloads.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { jobRoutes } from './routes/jobs.js';
import { videoRoutes } from './routes/videos.js';
import { mediaRoutes } from './routes/media.js';
import { logRoutes } from './routes/logs.js';
import { textRoutes } from './routes/text.js';
import { vllmRoutes } from './routes/vllm.js';
import { pythonRoutes } from './routes/python.js';
import { audioRoutes } from './routes/audio.js';
import { compatRoutes } from './routes/compat.js';
import { characterRoutes } from './routes/characters.js';
import { mcpRoutes } from './routes/mcp.js';
import './types.js';

const VERSION = '0.1.0';

export interface BuiltServer {
  app: FastifyInstance;
  /** Closing the database is not part of Fastify's lifecycle. */
  closeDb: () => void;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  const paths = buildPaths(config);
  await ensureDirs(paths);

  // Tee every log line to stdout (so container logs are unchanged) and into
  // the ring buffer the UI's log viewer reads. Fastify's `logger` option only
  // takes options; a pre-built instance needs `loggerInstance`.
  const logs = new LogBuffer();
  // Typed as FastifyBaseLogger rather than the concrete pino.Logger: leaving
  // it inferred makes Fastify's Logger generic resolve to that concrete type,
  // which stops every route plugin (typed against the default) from matching.
  //
  // Each stream entry needs its own explicit level. `pino.multistream()`
  // defaults every destination to 'info' and does *not* inherit the logger's
  // own level, so without this a debug-level deployment silently drops every
  // backend line before it reaches stdout or the buffer.
  //
  // `redact` keeps the `/mcp/<token>` form of the API token (src/auth.ts) out
  // of every log line, including the stdout a Kaggle kernel posts back.
  const logger: FastifyBaseLogger = pino(
    {
      level: config.logLevel,
      redact: { paths: ['req.url', 'originalUrl', 'url'], censor: redactTokenPath },
    },
    pino.multistream([
      { stream: process.stdout, level: config.logLevel },
      { stream: logs, level: config.logLevel },
    ]),
  );

  const { db, sqlite, temporary } = openDb(paths.dbFile, (movedTo, reason) =>
    logger.error({ movedTo, reason }, 'the database was corrupt; set it aside and started a new one'),
  );
  if (temporary) {
    logger.error(
      { file: paths.dbFile, reason: temporary },
      'the database cannot be written (is the data volume full?); keeping state in memory for this run — ' +
        'delete a model to free space, then restart',
    );
  }

  const app = Fastify({
    loggerInstance: logger,
    // Without this, close() hangs waiting for idle keep-alive sockets (an
    // OpenAI client's connection pool against /v1/llm/*, for one) to end on
    // their own, which Node's server.close() never forces.
    forceCloseConnections: true,
    // Generation payloads are small JSON; uploads go through multipart.
    bodyLimit: 4 * 1024 * 1024,
    requestTimeout: config.httpServerTimeoutMs,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // --- Services -------------------------------------------------------------

  const settings = new SettingsStore(db);
  const models = new ModelManager(paths, app.log);
  const backends = new BackendManager(config, paths, settings, app.log, logs);
  const catalogue = new CatalogueManager(config, paths, app.log);

  const storage = new StorageMonitor(
    paths.dataDir,
    config.dataVolumeGb ? config.dataVolumeGb * 1024 ** 3 : null,
  );

  const downloads = new DownloadManager(config, db, models, app.log, storage, (task) => {
    if (task.status !== 'completed') return;
    // A newly downloaded model is invisible to a backend that scanned its
    // directory at startup, so the download settling is what triggers the
    // rescan. Debounced inside the process manager, so a bundle whose
    // components finish together restarts once rather than five times.
    if (task.kind === 'llm') backends.scheduleRestart('llamacpp', 'llm model downloaded');
    // A text encoder can double as a chat model (models/text-encoders.ts).
    if ((task.kind === 'image' || task.kind === 'video') && task.slot === 'clip') {
      backends.scheduleRestart('llamacpp', 'text encoder downloaded');
    }
    if (task.kind === 'audio') {
      // audio.cpp needs a restart to see a new model, which interrupts any
      // request in flight. A Python-runner model (YuE2) is not audio.cpp's, so
      // its files arriving must not cost a running song.
      void models
        .find(task.bundle, ['audio'])
        .catch(() => null)
        .then((bundle) => {
          if (bundle?.manifest?.backend !== 'python') {
            backends.scheduleRestart('audiocpp', 'audio model downloaded');
          }
        });
    }
  });

  const snapshotDownloads = new SnapshotDownloader(paths, models, config.hfToken, app.log);
  snapshotDownloads.on('settled', (task) => {
    if (task.status !== 'completed') return;
    // A snapshot landing on disk can change what vLLM should be pointed at
    // (repo id -> local path — see `vllmManagedValues`), so a currently
    // running vLLM needs to pick that up the same way any other backend picks
    // up a finished download.
    backends.scheduleRestart('vllm', 'model snapshot downloaded');
  });

  const jobs = new JobManager(config, db, app.log, logs);
  // Built before the services so they can ask it for memory; the engines that
  // wrap those services are registered once they exist, below.
  const engines = new EngineRegistry(app.log);
  const images = new ImageService(config, paths, models, backends, app.log, logs);
  const pythonVideo = new PythonVideoService(config, paths, backends, engines, app.log, logs);
  const upscaler = new UpscaleService(config, paths, images, pythonVideo, settings, app.log);
  const speech = new AudioService(config, paths, backends, app.log, logs);
  const text = new TextService(config, backends, app.log, logs);
  const characterService = new CharacterService(db, paths, jobs, models, text, engines, config, app.log);

  // llama.cpp scans a directory one level deep, which is one level shallower
  // than pepper's bundle layout. The scan directory bridges the two.
  backends.setPrepare('llamacpp', async () => {
    const { path } = await writeLlmScanDir(paths, models, app.log);
    return { managed: { models_dir: path } };
  });

  // audio.cpp loads an explicit registry rather than scanning a directory, so
  // it is regenerated before every spawn. An empty registry means the backend
  // is skipped entirely: it exits 1 on a zero-model config, and "no audio
  // models installed yet" is a normal state on a fresh deployment.
  backends.setPrepare('audiocpp', async () => {
    const { path, modelIds } = await writeAudioServerConfig(paths, models, app.log);
    if (modelIds.length === 0) {
      return { skip: true, reason: 'no audio models installed yet' };
    }
    return { managed: { config: path } };
  });

  // vLLM serves one model per process and cannot hot-swap, so "which model"
  // is a setting (Preferences), not something scanned off disk. An empty
  // setting or a bundle missing `huggingface_id` skips the spawn rather than
  // failing startup — both are ordinary states before a user has picked a
  // vLLM model at all.
  backends.setPrepare('vllm', async () => {
    const modelId = settings.get(vllmActiveModelKey());
    if (!modelId) return { skip: true, reason: 'no vLLM model selected' };
    const bundle = await models.find(modelId).catch(() => null);
    if (!bundle) return { skip: true, reason: `selected vLLM model "${modelId}" not found` };
    try {
      return { managed: await vllmManagedValues(paths, bundle) };
    } catch (err) {
      return { skip: true, reason: (err as Error).message };
    }
  });

  // Same shape as vLLM's hook: one model per process, selected in
  // Preferences. `pythonManagedValues` itself distinguishes "no model
  // selected" from "selected but its package isn't installed yet" — both
  // land here as an ordinary skip rather than a startup failure.
  backends.setPrepare('python', async () => {
    const modelId = settings.get(pythonActiveModelKey());
    if (!modelId) return { skip: true, reason: 'no Python model selected' };
    const bundle = await models.find(modelId).catch(() => null);
    if (!bundle) return { skip: true, reason: `selected Python model "${modelId}" not found` };
    try {
      const { argvPrefix, healthPath } = await pythonManagedValues(paths, backends.python, bundle);
      return { argvPrefix, healthPath };
    } catch (err) {
      return { skip: true, reason: (err as Error).message };
    }
  });

  for (const engine of createPepperEngines({
    jobs,
    images,
    upscaler,
    pythonVideo,
    models,
    speech,
    text,
    backends,
    paths,
  })) {
    engines.register(engine);
  }
  engines.attach(jobs);

  app.decorate('config', config);
  app.decorate('paths', paths);
  app.decorate('db', db as Db);
  app.decorate('settings', settings);
  app.decorate('logs', logs);
  app.decorate('backends', backends);
  app.decorate('models', models);
  app.decorate('catalogue', catalogue);
  app.decorate('downloads', downloads);
  app.decorate('snapshotDownloads', snapshotDownloads);
  app.decorate('jobs', jobs);
  app.decorate('engines', engines);
  app.decorate('images', images);
  app.decorate('upscaler', upscaler);
  app.decorate('pythonVideo', pythonVideo);
  app.decorate('characters', characterService);
  app.decorate('resources', new ResourceMonitor());
  app.decorate('storage', storage);
  app.decorate('activity', new ActivityTracker());
  // `version` is taken by Fastify itself, so the app's own version needs a
  // distinct name rather than shadowing the framework's.
  app.decorate('appVersion', VERSION);

  // --- Plugins --------------------------------------------------------------

  // First, so the token check covers every route below — /docs included.
  registerAuthHook(app, config.apiToken);
  app.addHook('onResponse', async (request, reply) => {
    if (isActivity(request.method, request.url, reply.statusCode, request.body)) app.activity.touch();
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 512 * 1024 * 1024 },
  });

  // Lets the live streams answer a WebSocket upgrade on their SSE URLs — see
  // util/sse.ts for why both transports exist.
  await app.register(fastifyWebsocket);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Pepper API',
        description:
          'Media generation API for image, video, audio and text. Backward compatible with sd-api.',
        version: VERSION,
      },
      tags: [
        { name: 'system', description: 'Health, configuration and credentials' },
        { name: 'backends', description: 'Backend lifecycle and CLI arguments' },
        { name: 'models', description: 'Installed model bundles' },
        { name: 'catalogue', description: 'Remote model catalogue' },
        { name: 'downloads', description: 'Weight downloads' },
        { name: 'jobs', description: 'Generation jobs' },
        { name: 'media', description: 'Outputs and uploads' },
        { name: 'audio', description: 'Speech, voice design and transcription' },
        { name: 'text', description: 'Text generation' },
        { name: 'characters', description: 'Character Studio' },
        { name: 'logs', description: 'Log query and live tail' },
        { name: 'compat', description: 'sd-api compatible endpoints' },
        { name: 'mcp', description: 'Model Context Protocol endpoint for Claude' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // --- Error handling -------------------------------------------------------

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number; validation?: unknown };
    if (error instanceof AppError) {
      // Client mistakes are not incidents: logging a 404 at error level is how
      // a log viewer fills with noise and stops being read.
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level]({ err: error, code: error.code }, error.message);
      return reply.code(error.statusCode).send(error.toResponse());
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          details: error.issues,
        },
      });
    }

    // fastify-type-provider-zod wraps validation failures rather than
    // rethrowing the ZodError, so the branch above never sees them.
    const validation = (error as { validation?: unknown }).validation;
    if (validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, details: validation },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(error.statusCode ?? 500).send({
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    // Anything that is not an API call is the SPA's own routing: serve the
    // shell and let the client router resolve it, so a deep link works on a
    // hard refresh.
    if (
      !request.url.startsWith('/v1') &&
      !request.url.startsWith('/docs') &&
      !request.url.startsWith('/mcp') &&
      request.method === 'GET'
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  // --- Routes ---------------------------------------------------------------

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(modelRoutes);
  await app.register(downloadRoutes);
  await app.register(catalogueRoutes);
  await app.register(jobRoutes);
  await app.register(videoRoutes);
  await app.register(mediaRoutes);
  await app.register(logRoutes);
  await app.register(textRoutes);
  // Encapsulated: this scope also swaps in a no-op multipart parser (for
  // vLLM-Omni's multipart video endpoint), which must not affect /v1/inputs.
  await app.register(vllmRoutes);
  await app.register(pythonRoutes);
  // Encapsulated: this scope swaps in a no-op multipart parser so transcription
  // uploads can be forwarded byte for byte, which must not affect /v1/inputs.
  await app.register(audioRoutes);
  await app.register(compatRoutes);
  await app.register(characterRoutes);
  await app.register(mcpRoutes);

  // The built SPA. Registered last so it never shadows an API route — its
  // wildcard route is the least specific thing in the tree, and a path it has
  // no file for falls through to the not-found handler, which serves the
  // shell so client-side routes survive a hard refresh.
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: staticRoot });

  return { app, closeDb: () => sqlite.close() };
}
