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
import { buildPaths, bundleDir, ensureDirs, safeResolve } from './paths.js';
import { uniqueOutputName } from './util/files.js';
import { randomInt } from 'node:crypto';
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
import { ImageService } from './services/image.js';
import { UpscaleService } from './services/upscale.js';
import { PythonVideoService } from './services/python-video.js';
import type { GenerateParams } from './schemas/generate.js';
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
  const images = new ImageService(config, paths, models, backends, app.log, logs);
  const pythonVideo = new PythonVideoService(config, paths, backends, app.log, logs);
  const upscaler = new UpscaleService(config, paths, images, pythonVideo, settings, app.log);
  const speech = new AudioService(config, paths, backends, app.log, logs);
  const text = new TextService(config, backends, app.log, logs);
  const characterService = new CharacterService(db, paths, jobs, models, text, backends, config, app.log);

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

  registerExecutors(jobs, images, upscaler, pythonVideo, models, speech, text, paths);

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

/**
 * Wire each job kind to the service that runs it. Image and video share an
 * executor because they share a generator — the bundle's mode is what decides
 * which one a run produces.
 */
function registerExecutors(
  jobs: JobManager,
  images: ImageService,
  upscaler: UpscaleService,
  pythonVideo: PythonVideoService,
  models: ModelManager,
  speech: AudioService,
  text: TextService,
  paths: ReturnType<typeof buildPaths>,
): void {
  const generate: Parameters<JobManager['registerExecutor']>[1] = async (context) => {
    // Upscales ride the image queue: they hold the same GPU, show up in the
    // same job list, and produce an image output like any other.
    if (context.job.params.task === 'upscale') return runUpscale(context);

    // Bundles served by the Python backend run through Pepper's own runners
    // (server/python/pepper_runner); everything else is sd-cli.
    const params = context.job.params as GenerateParams;
    const bundle = await models.find(params.model, ['image', 'video']).catch(() => null);
    if (bundle?.manifest?.backend === 'python') {
      const run = await pythonVideo.generate({
        bundle,
        params,
        signal: context.signal,
        onProgress: context.onProgress,
        onLog: context.onLog,
      });
      return {
        video_path: run.outputPath,
        video_url: `/v1/outputs/${encodeURIComponent(run.outputName)}`,
        metadata: {
          kind: 'video',
          backend: 'python',
          runner: bundle.manifest.python_runner,
          prompt: run.params.prompt,
          negative_prompt: run.params.negative_prompt,
          model: run.params.model,
          steps: run.params.steps ?? bundle.manifest.defaults?.steps,
          cfg_scale: run.params.cfg_scale ?? bundle.manifest.defaults?.cfg_scale,
          seed: run.params.seed,
          init_image: run.params.init_image,
          audio: run.params.audio,
          ...run.runner,
          video_frames: run.runner.frames,
          duration_ms: run.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }

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
        checkpoint: result.params.checkpoint,
        steps: result.params.steps,
        cfg_scale: result.params.cfg_scale,
        width: result.params.width,
        height: result.params.height,
        seed: result.params.seed,
        sampler: result.params.sampler,
        scheduler: result.params.scheduler,
        // The upscaler's directory is local detail; the rest reproduces the pass.
        hires: result.hires ? { ...result.hires, upscalersDir: undefined } : undefined,
        video_frames: result.params.video_frames,
        flow_shift: result.params.flow_shift,
        fps: result.s2v?.fps ?? result.params.fps,
        // Only present on a speech-driven run. How many chunks it took is the
        // number that explains the runtime, so it belongs in the result rather
        // than only in the logs.
        audio_duration_s: result.s2v?.audioDurationSeconds,
        audio_chunks: result.s2v?.chunks,
        // Everything else needed to reproduce the image from the Media page.
        negative_prompt: result.params.negative_prompt,
        init_image: result.params.init_image,
        strength: result.params.init_image ? result.params.strength : undefined,
        ref_images: result.params.ref_images,
        img_cfg_scale: result.params.ref_images?.length ? result.params.img_cfg_scale : undefined,
        increase_ref_index: result.params.increase_ref_index,
        loras: result.params.loras,
        sigmas: result.params.sigmas,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  const runUpscale: Parameters<JobManager['registerExecutor']>[1] = async (context) => {
    const params = context.job.params as {
      image: string;
      source?: 'output' | 'upload';
      scale?: 2 | 4;
      upscaler?: string;
      resolution?: number;
      quality?: 'best' | 'sharp' | 'fast';
    };
    const source = params.source ?? 'output';
    const inputPath = await upscaler.resolveSource(params.image, source);

    if (/\.(webm|mp4|mov|mkv|avi)$/i.test(params.image)) {
      const origin =
        source === 'output'
          ? ((jobs.findByOutput(params.image)?.result?.metadata as Record<string, unknown> | undefined) ?? {})
          : {};
      const video = await upscaler.upscaleVideo({
        inputPath,
        resolution: params.resolution ?? 1080,
        quality: params.quality ?? 'best',
        onProgress: context.onProgress,
        onLog: context.onLog,
        signal: context.signal,
      });
      return {
        video_path: video.outputPath,
        video_url: `/v1/outputs/${encodeURIComponent(video.outputName)}`,
        metadata: {
          ...origin,
          kind: 'video',
          task: 'upscale',
          source_video: params.image,
          resolution: video.resolution,
          upscaler: video.model,
          upscale_engine: 'seedvr2',
          duration_ms: video.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }
    if (params.scale === undefined) throw new Error('Image upscales need a scale (2 or 4)');
    const result = await upscaler.upscale({
      inputPath,
      scale: params.scale,
      model: params.upscaler,
      signal: context.signal,
      onProgress: context.onProgress,
      onLog: context.onLog,
    });

    // Carry the source image's generation settings forward, so an upscaled
    // image can still be reproduced or reused from the Media page.
    const origin =
      source === 'output'
        ? ((jobs.findByOutput(params.image)?.result?.metadata as Record<string, unknown> | undefined) ?? {})
        : {};

    return {
      image_path: result.outputPath,
      image_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
      metadata: {
        ...origin,
        kind: 'image',
        task: 'upscale',
        scale: result.scale,
        source_image: params.image,
        source_width: result.sourceWidth,
        source_height: result.sourceHeight,
        width: result.width,
        height: result.height,
        upscaler: result.model,
        upscale_engine: result.engine,
        upscale_architecture: result.architecture,
        upscale_method: result.method,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  jobs.registerExecutor('image', generate);
  jobs.registerExecutor('video', generate);

  jobs.registerExecutor('audio', async (context) => {
    // Music rides the audio queue: same backend, same memory budget.
    if (context.job.params.task === 'music') {
      const musicParams = context.job.params as { model: string };
      const bundle = await models.find(musicParams.model, ['audio']).catch(() => null);
      const result =
        bundle?.manifest?.backend === 'python'
          ? await pythonMusic(pythonVideo, paths, bundle, context)
          : await speech.generateMusic({
              params: context.job.params as never,
              family: bundle?.manifest?.family,
              signal: context.signal,
              onLog: context.onLog,
            });
      const params = result.params as Record<string, unknown>;
      return {
        audio_path: result.outputPath,
        audio_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
        metadata: {
          kind: 'audio',
          task: 'music',
          model: params.model,
          prompt: params.prompt,
          lyrics: params.lyrics,
          duration_seconds: params.duration_seconds,
          steps: params.steps,
          seed: params.seed,
          duration_ms: result.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }

    const result = await speech.generate({
      params: context.job.params as never,
      signal: context.signal,
      onLog: context.onLog,
    });

    return {
      audio_path: result.outputPath,
      audio_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
      metadata: {
        kind: 'audio',
        model: result.params.model,
        input: result.params.input,
        voice: result.params.voice,
        voice_ref: result.params.voice_ref,
        instructions: result.params.instructions,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  });

  // Text is the one kind whose result is not a file — see services/text-gen.ts.
  jobs.registerExecutor('text', async (context) => {
    const result = await text.generate({
      params: context.job.params as never,
      signal: context.signal,
      onLog: context.onLog,
    });

    return {
      text: result.text,
      metadata: {
        kind: 'text',
        model: result.params.model,
        usage: result.usage,
        finish_reason: result.finishReason,
        duration_ms: result.durationMs,
      },
    };
  });
}

/**
 * YuE2 in its own venv (python/pepper_runner/runners/yue2.py). Its package pins
 * torch 2.10 / transformers 4.57, so it cannot share the runner environment.
 * The model's weights are the bundle's; its VAE is fetched from HuggingFace on
 * first use into the models volume, hence the network being allowed.
 */
export const YUE2_ENVIRONMENT = {
  name: 'yue2',
  packages: ['https://huggingface.co/m-a-p/YuE2-3B/resolve/main/yue2_infer-0.1.5-py3-none-any.whl'],
};

async function pythonMusic(
  pythonVideo: PythonVideoService,
  paths: ReturnType<typeof buildPaths>,
  bundle: NonNullable<Awaited<ReturnType<ModelManager['find']>>>,
  context: Parameters<Parameters<JobManager['registerExecutor']>[1]>[0],
): Promise<{ outputPath: string; outputName: string; durationMs: number; params: Record<string, unknown> }> {
  const params = context.job.params as {
    prompt: string;
    lyrics?: string;
    seed?: number;
  };
  const started = Date.now();
  const seed = params.seed !== undefined && params.seed >= 0 ? params.seed : randomInt(0, 2 ** 31 - 1);
  const outputName = uniqueOutputName('wav', 'music');
  const outputPath = safeResolve(paths.outputDir, outputName);
  await pythonVideo.runTask({
    runner: bundle.manifest?.python_runner ?? 'yue2',
    output: outputPath,
    environment: YUE2_ENVIRONMENT,
    env: { HF_HUB_OFFLINE: '0', HF_HOME: join(paths.modelsDir, '.hf-cache') },
    params: {
      model_dir: join(bundleDir(paths, 'audio', bundle.id), 'weights'),
      vae_dir: join(bundleDir(paths, 'audio', bundle.id), 'aux'),
      style: params.prompt,
      lyrics: params.lyrics ?? '',
      seed,
    },
    inputs: {},
    onProgress: context.onProgress,
    onLog: context.onLog,
    signal: context.signal,
  });
  return { outputPath, outputName, durationMs: Date.now() - started, params: { ...params, seed } };
}
