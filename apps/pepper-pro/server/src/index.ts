import 'dotenv/config';
import { onShutdown, scheduleOutputRetention } from '@pepper/core/serve.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

/**
 * Entry point. As in Pepper, the server listens before anything slow
 * happens: ComfyUI and llama.cpp start on the first job that needs them, so a
 * cold pod answers its health check immediately.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const server = await buildServer(config);
  const { app } = server;

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { dataDir: config.dataDir, outputDir: config.outputDir, tier: config.tier, comfyDir: config.comfyDir },
    'pepper pro is listening',
  );

  server.backends
    .refreshInstalled()
    .then(() => server.backends.reapOrphans())
    .catch((err) => app.log.warn({ err: (err as Error).message }, 'failed to inspect installed backends'));
  server.jobs.recoverInterrupted();
  server.downloads.recoverInterrupted();
  scheduleOutputRetention(server.paths.outputDir, config.outputRetentionMs, app.log);

  if (config.autoInstallBackends) {
    void server.backends.ensureInstalled('llamacpp').catch((err) => {
      app.log.warn({ err: (err as Error).message }, 'llama.cpp could not be installed');
    });
  }

  onShutdown(app.log, async () => {
    await app.close();
    await server.engines.shutdown();
    await server.backends.stopAll();
    server.closeDb();
  });
}

main().catch((err) => {
  console.error('Failed to start pepper pro:', err);
  process.exit(1);
});
