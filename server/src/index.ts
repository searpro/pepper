import 'dotenv/config';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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

  // Reconcile whatever the previous process left behind.
  app.backends.refreshInstalled().catch((err) => {
    app.log.warn({ err: (err as Error).message }, 'failed to inspect installed backends');
  });
  app.jobs.recoverInterrupted();
  app.downloads.recoverInterrupted();

  void app.catalogue.loadAtStartup();
  void converge(app);

  scheduleOutputRetention(app);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    // Order matters: stop accepting requests, then kill children. Reversing it
    // leaves a request being served by a process that has just been killed.
    try {
      await app.close();
      app.images.killAll();
      await app.backends.stopAll();
      closeDb();
    } catch (err) {
      app.log.error({ err: (err as Error).message }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Install and start backends in the background.
 *
 * Every step is non-fatal on purpose. A box with no audio models should still
 * serve images; a llama.cpp release that fails to download should not take the
 * whole API down. What each failure costs is one backend, and the status
 * endpoint says which one and why.
 */
async function converge(app: Awaited<ReturnType<typeof buildServer>>['app']): Promise<void> {
  const { config } = app;

  if (!config.autoInstallBackends) {
    app.log.info('AUTO_INSTALL_BACKENDS is off — backends must be installed manually');
    return;
  }

  // sd-cli is spawned per generation, so it only needs to exist, not run.
  await app.backends.ensureInstalled('sdcpp').catch((err) => {
    app.log.warn({ err: (err as Error).message }, 'stable-diffusion.cpp is unavailable');
  });

  for (const backend of ['llamacpp', 'audiocpp'] as const) {
    try {
      await app.backends.ensureRunning(backend);
    } catch (err) {
      app.log.warn({ backend, err: (err as Error).message }, 'backend did not start');
    }
  }
}

/**
 * Sweep old outputs (see `Config.outputDir` for why they are ephemeral by
 * default). Runs hourly and on boot, since a container that restarts more
 * often than the interval would otherwise never sweep at all.
 */
function scheduleOutputRetention(app: Awaited<ReturnType<typeof buildServer>>['app']): void {
  const { outputRetentionMs } = app.config;
  if (outputRetentionMs <= 0) return;

  const sweep = async () => {
    const cutoff = Date.now() - outputRetentionMs;
    let removed = 0;
    try {
      for (const name of await readdir(app.paths.outputDir)) {
        const path = join(app.paths.outputDir, name);
        try {
          const info = await stat(path);
          if (info.isFile() && info.mtimeMs < cutoff) {
            await unlink(path);
            removed++;
          }
        } catch {
          // Raced with a reader or another sweep; skip it.
        }
      }
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'output retention sweep failed');
      return;
    }
    if (removed > 0) app.log.info({ removed }, 'swept expired outputs');
  };

  void sweep();
  const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
  timer.unref();
}

main().catch((err) => {
  // No logger yet if buildServer() itself threw, so this is the one place a
  // bare console write is the right call.
  console.error('Failed to start pepper:', err);
  process.exit(1);
});
