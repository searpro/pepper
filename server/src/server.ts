import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import { authRoutes } from './core/auth.js';
import { createCoreApp, serveSpa } from './core/app.js';
import type { FastifyInstance } from 'fastify';
import { buildPaths, ensureDirs, MODEL_KINDS, type ModelKind } from './paths.js';
import type { ComponentSlot } from './models/bundle.js';
import type { Db } from './db/client.js';
import { PEPPER_MIGRATIONS, PEPPER_SCHEMA_SQL } from './db/schema.js';
import { PepperBackendManager } from './backends/pepper-backends.js';
import { vllmActiveModelKey, vllmManagedValues } from './backends/vllm.js';
import { ensurePythonPackageInstalled, pythonActiveModelKey, pythonManagedValues } from './backends/python.js';
import { ModelManager } from './models/manager.js';
import { CatalogueManager } from './catalogue/manager.js';
import { DownloadManager } from './downloads/manager.js';
import { SnapshotDownloader } from './downloads/snapshot.js';
import { JobManager } from './core/jobs/manager.js';
import { EngineRegistry } from './core/engines/engine.js';
import { createPepperEngines } from './engines/pepper.js';
import { ImageService } from './services/image.js';
import { UpscaleService } from './services/upscale.js';
import { PythonVideoService } from './services/python-video.js';
import { writeAudioServerConfig } from './services/audio-config.js';
import { writeLlmScanDir } from './services/llm-scan-dir.js';
import { AudioService } from './services/audio-gen.js';
import { TextService } from './core/services/text-gen.js';
import { CharacterService } from './services/characters.js';
import { ResourceMonitor } from './core/services/resources.js';
import { StorageMonitor } from './core/services/storage.js';
import { systemRoutes } from './core/routes/system.js';
import { modelRoutes } from './routes/models.js';
import { downloadRoutes } from './core/routes/downloads.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { jobRoutes } from './routes/jobs.js';
import { videoRoutes } from './routes/videos.js';
import { mediaRoutes } from './core/routes/media.js';
import { upscalerRoutes } from './routes/upscalers.js';
import { logRoutes } from './core/routes/logs.js';
import { coreJobRoutes } from './core/routes/jobs.js';
import { textRoutes } from './routes/text.js';
import { vllmRoutes } from './routes/vllm.js';
import { pythonRoutes } from './routes/python.js';
import { audioRoutes } from './routes/audio.js';
import { compatRoutes } from './routes/compat.js';
import { characterRoutes } from './routes/characters.js';
import { mcpRoutes } from './core/routes/mcp.js';
import { registerPepperTools } from './mcp/tools.js';
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

  const { app, logs, db, settings, activity, closeDb } = await createCoreApp({
    config,
    paths,
    product: {
      title: 'Pepper API',
      description: 'Media generation API for image, video, audio and text. Backward compatible with sd-api.',
      version: VERSION,
      tags: [
        { name: 'models', description: 'Installed model bundles' },
        { name: 'catalogue', description: 'Remote model catalogue' },
        { name: 'audio', description: 'Speech, voice design and transcription' },
        { name: 'text', description: 'Text generation' },
        { name: 'characters', description: 'Character Studio' },
        { name: 'compat', description: 'sd-api compatible endpoints' },
      ],
    },
    schema: { name: 'pepper', sql: PEPPER_SCHEMA_SQL, migrations: PEPPER_MIGRATIONS },
  });

  // --- Services -------------------------------------------------------------

  const models = new ModelManager(paths, app.log);
  const backends = new PepperBackendManager(config, paths, settings, app.log, logs);
  const catalogue = new CatalogueManager(config, paths, app.log);

  const storage = new StorageMonitor(
    paths.dataDir,
    config.dataVolumeGb ? config.dataVolumeGb * 1024 ** 3 : null,
  );

  const downloads = new DownloadManager<ModelKind, ComponentSlot>(config, db, models, app.log, storage, (task) => {
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
  app.decorate('activity', activity);
  // `version` is taken by Fastify itself, so the app's own version needs a
  // distinct name rather than shadowing the framework's.
  app.decorate('appVersion', VERSION);

  // --- Routes ---------------------------------------------------------------

  await app.register(authRoutes);
  await app.register(systemRoutes, {
    version: VERSION,
    config,
    paths,
    backends,
    engines,
    jobs,
    downloads,
    resources: app.resources,
    storage,
    activity: app.activity,
    isBusy: () => snapshotDownloads.list().some((task) => task.status === 'downloading'),
    status: () => ({ catalogue: catalogue.state(), generators: images.stats }),
    afterInstall: async (backend) => {
      // The runtime alone spawns nothing: whichever bundle is selected in
      // Preferences still needs its `python_package` cloned into the venv
      // before `pythonManagedValues` (the prepare hook) will let the process
      // start. Piggybacking this on the same "install" action keeps the
      // Python backend a one-click install like every other backend, rather
      // than a second, undiscoverable step.
      if (backend !== 'python') return;
      // torch, diffusers & co. for Pepper's runners, so the first video job
      // does not spend its first minutes installing them.
      await pythonVideo.prepare((line) => app.log.info(line));
      const modelId = settings.get(pythonActiveModelKey());
      if (!modelId) return;
      const bundle = await models.find(modelId).catch(() => null);
      if (!bundle) return;
      await ensurePythonPackageInstalled(backends.python, bundle.manifest);
      backends.scheduleRestart('python', 'model package installed');
    },
  });
  await app.register(modelRoutes);
  await app.register(downloadRoutes, { downloads, kinds: MODEL_KINDS });
  await app.register(snapshotRoutes);
  await app.register(catalogueRoutes);
  await app.register(coreJobRoutes, { jobs });
  await app.register(jobRoutes);
  await app.register(videoRoutes);
  await app.register(mediaRoutes, { paths, jobs });
  await app.register(upscalerRoutes);
  await app.register(logRoutes, { logs, backendSources: backends.ids() });
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
  await app.register(mcpRoutes, {
    name: 'pepper',
    version: VERSION,
    port: config.port,
    context: { apiToken: config.apiToken, jobs, outputDir: paths.outputDir, uploadsDir: paths.uploadsDir },
    register: registerPepperTools,
  });

  await serveSpa(app, join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

  return { app, closeDb };
}
