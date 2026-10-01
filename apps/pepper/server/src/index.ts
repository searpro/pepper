import 'dotenv/config';
import { onShutdown, scheduleOutputRetention } from '@pepper/core/serve.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

/**
 * Entry point.
 *
 * The ordering here is deliberate: the HTTP server starts listening *before*
 * backends are installed or started. Installing a backend downloads hundreds
 * of megabytes and starting one loads a model, so blocking the listen on them
 * means a container that fails its health check for minutes and gets killed
 * and restarted by the orchestrator — over and over, never finishing the
 * download it keeps restarting. Serving immediately and converging in the
 * background is what makes a cold start on RunPod survivable.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { app, closeDb } = await buildServer(config);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      dataDir: config.dataDir,
      outputDir: config.outputDir,
      accel: config.accel,
      autoInstall: config.autoInstallBackends,
    },
    'pepper is listening',
  );

  // Reconcile whatever the previous process left behind — including backend
  // processes it failed to stop, which would otherwise hold their models
  // (and their ports) until something happened to need that backend.
  app.backends
    .refreshInstalled()
    .then(() => app.backends.reapOrphans())
    .catch((err) => {
      app.log.warn({ err: (err as Error).message }, 'failed to inspect installed backends');
    });
  app.jobs.recoverInterrupted();
  app.downloads.recoverInterrupted();

  void app.catalogue.loadAtStartup();
  void converge(app);

  scheduleOutputRetention(app.paths.outputDir, app.config.outputRetentionMs, app.log);

  // Order matters: stop accepting requests, then kill children. Reversing it
  // leaves a request being served by a process that has just been killed.
  onShutdown(app.log, async () => {
    await app.close();
    await app.engines.shutdown();
    await app.backends.stopAll();
    closeDb();
  });
}

/**
 * Install backends in the background — but do not start them.
 *
 * Servers are started on demand by the first job or request that needs one
 * and stopped again after the idle timeout (see `ManagedProcess`). Starting
 * llama.cpp and audio.cpp at boot held gigabytes of models resident for
 * nothing — audio.cpp alone loads every registered model up front — and on
 * unified memory that was memory the image and video jobs did not get.
 * Installing now still means the first job does not wait on a download.
 *
 * Every step is non-fatal on purpose: a llama.cpp release that fails to
 * download should not take image generation down with it.
 */
async function converge(app: Awaited<ReturnType<typeof buildServer>>['app']): Promise<void> {
  const { config } = app;

  if (!config.autoInstallBackends) {
    app.log.info('AUTO_INSTALL_BACKENDS is off — backends must be installed manually');
    return;
  }

  for (const backend of ['sdcpp', 'llamacpp', 'audiocpp'] as const) {
    await app.backends.ensureInstalled(backend).catch((err) => {
      app.log.warn({ backend, err: (err as Error).message }, 'backend could not be installed');
    });
  }
}

main().catch((err) => {
  // No logger yet if buildServer() itself threw, so this is the one place a
  // bare console write is the right call.
  console.error('Failed to start pepper:', err);
  process.exit(1);
});
