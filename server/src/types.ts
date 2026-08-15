import type { Config } from './config.js';
import type { Paths } from './paths.js';
import type { Db } from './db/client.js';
import type { SettingsStore } from './db/settings.js';
import type { LogBuffer } from './logs/buffer.js';
import type { BackendManager } from './backends/manager.js';
import type { ModelManager } from './models/manager.js';
import type { CatalogueManager } from './catalogue/manager.js';
import type { DownloadManager } from './downloads/manager.js';
import type { JobManager } from './jobs/manager.js';
import type { ImageService } from './services/image.js';

/**
 * Services decorated onto the Fastify instance. Constructed once in
 * `buildServer()` and shared by every route — the same pattern sd-api used,
 * kept because it makes a route's dependencies visible at the call site
 * instead of hidden behind module-level singletons.
 */
declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    paths: Paths;
    db: Db;
    settings: SettingsStore;
    logs: LogBuffer;
    backends: BackendManager;
    models: ModelManager;
    catalogue: CatalogueManager;
    downloads: DownloadManager;
    jobs: JobManager;
    images: ImageService;
    appVersion: string;
  }
}

export {};
