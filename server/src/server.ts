import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
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
import { buildPaths, ensureDirs } from './paths.js';
import { openDb, type Db } from './db/client.js';
import { SettingsStore } from './db/settings.js';
import { LogBuffer } from './logs/buffer.js';
import { BackendManager } from './backends/manager.js';
import { ModelManager } from './models/manager.js';
import { CatalogueManager } from './catalogue/manager.js';
import { DownloadManager } from './downloads/manager.js';
import { JobManager } from './jobs/manager.js';
import { ImageService } from './services/image.js';
import { writeAudioServerConfig } from './services/audio-config.js';
import { systemRoutes } from './routes/system.js';
import { modelRoutes } from './routes/models.js';
import { downloadRoutes } from './routes/downloads.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { jobRoutes } from './routes/jobs.js';
import { mediaRoutes } from './routes/media.js';
import { logRoutes } from './routes/logs.js';
import { textRoutes } from './routes/text.js';
import { audioRoutes } from './routes/audio.js';
import { compatRoutes } from './routes/compat.js';
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
  const logger: FastifyBaseLogger = pino(
    { level: config.logLevel },
    pino.multistream([
      { stream: process.stdout, level: config.logLevel },
      { stream: logs, level: config.logLevel },
    ]),
  );

  const { db, sqlite } = openDb(paths.dbFile);

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

  const downloads = new DownloadManager(config, db, models, app.log, (task) => {
    if (task.status !== 'completed') return;
    // A newly downloaded model is invisible to a backend that scanned its
    // directory at startup, so the download settling is what triggers the
    // rescan. Debounced inside the process manager, so a bundle whose
    // components finish together restarts once rather than five times.
    if (task.kind === 'llm') backends.scheduleRestart('llamacpp', 'llm model downloaded');
    if (task.kind === 'audio') backends.scheduleRestart('audiocpp', 'audio model downloaded');
  });

  const jobs = new JobManager(config, db, app.log, logs);
  const images = new ImageService(config, paths, models, backends, app.log, logs);

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

  registerExecutors(jobs, images, paths);

  app.decorate('config', config);
  app.decorate('paths', paths);
  app.decorate('db', db as Db);
  app.decorate('settings', settings);
  app.decorate('logs', logs);
  app.decorate('backends', backends);
  app.decorate('models', models);
  app.decorate('catalogue', catalogue);
  app.decorate('downloads', downloads);
  app.decorate('jobs', jobs);
  app.decorate('images', images);
  // `version` is taken by Fastify itself, so the app's own version needs a
  // distinct name rather than shadowing the framework's.
  app.decorate('appVersion', VERSION);

  // --- Plugins --------------------------------------------------------------

  await app.register(fastifyMultipart, {
    limits: { fileSize: 512 * 1024 * 1024 },
  });

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
        { name: 'logs', description: 'Log query and live tail' },
        { name: 'compat', description: 'sd-api compatible endpoints' },
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
    if (!request.url.startsWith('/v1') && !request.url.startsWith('/docs') && request.method === 'GET') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  // --- Routes ---------------------------------------------------------------

  await app.register(systemRoutes);
  await app.register(modelRoutes);
  await app.register(downloadRoutes);
  await app.register(catalogueRoutes);
  await app.register(jobRoutes);
  await app.register(mediaRoutes);
  await app.register(logRoutes);
  await app.register(textRoutes);
  // Encapsulated: this scope swaps in a no-op multipart parser so transcription
  // uploads can be forwarded byte for byte, which must not affect /v1/inputs.
  await app.register(audioRoutes);
  await app.register(compatRoutes);

  // The built SPA. Registered last so it never shadows an API route — its
  // wildcard route is the least specific thing in the tree, and a path it has
  // no file for falls through to the not-found handler, which serves the
  // shell so client-side routes survive a hard refresh.
  const staticRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: staticRoot });

  return { app, closeDb: () => sqlite.close() };
}

/**
 * Wire each job kind to the service that runs it. Image and video share an
 * executor because they share a generator — the bundle's mode is what decides
 * which one a run produces.
 */
function registerExecutors(
  jobs: JobManager,
  images: ImageService,
  paths: ReturnType<typeof buildPaths>,
): void {
  const generate: Parameters<JobManager['registerExecutor']>[1] = async (context) => {
    const result = await images.generate({
      params: context.job.params as never,
      signal: context.signal,
      onProgress: context.onProgress,
      onLog: context.onLog,
    });

    const url = `/v1/outputs/${encodeURIComponent(result.outputName)}`;
    return {
      ...(result.kind === 'video'
        ? { video_path: result.outputPath, video_url: url }
        : { image_path: result.outputPath, image_url: url }),
      metadata: {
        kind: result.kind,
        prompt: result.params.prompt,
        model: result.params.model,
        steps: result.params.steps,
        cfg_scale: result.params.cfg_scale,
        width: result.params.width,
        height: result.params.height,
        seed: result.params.seed,
        sampler: result.params.sampler,
        video_frames: result.params.video_frames,
        flow_shift: result.params.flow_shift,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  jobs.registerExecutor('image', generate);
  jobs.registerExecutor('video', generate);
}
