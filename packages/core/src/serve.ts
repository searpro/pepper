import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Sweep old outputs (see `CoreConfig.outputDir` for why they are ephemeral
 * by default). Runs hourly and on boot, since a container that restarts more
 * often than the interval would otherwise never sweep at all.
 */
export function scheduleOutputRetention(outputDir: string, retentionMs: number, log: FastifyBaseLogger): void {
  if (retentionMs <= 0) return;

  const sweep = async () => {
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    try {
      for (const name of await readdir(outputDir)) {
        const path = join(outputDir, name);
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
      log.warn({ err: (err as Error).message }, 'output retention sweep failed');
      return;
    }
    if (removed > 0) log.info({ removed }, 'swept expired outputs');
  };

  void sweep();
  const timer = setInterval(() => void sweep(), 60 * 60 * 1000);
  timer.unref();
}

/** Stop on SIGTERM/SIGINT: stop taking requests first, then the children, then exit. */
export function onShutdown(log: FastifyBaseLogger, stop: () => Promise<void>): void {
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await stop();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
