import type { Config } from './config.js';
import type { Paths } from './paths.js';
import type { Db } from './db/client.js';
import type { SettingsStore } from '@pepper/core/db/settings.js';
import type { LogBuffer } from '@pepper/core/logs/buffer.js';
import type { PepperBackendManager } from './backends/pepper-backends.js';
import type { ModelManager } from './models/manager.js';
import type { CatalogueManager } from './catalogue/manager.js';
import type { PepperDownloadManager } from './downloads/manager.js';
import type { SnapshotDownloader } from './downloads/snapshot.js';
import type { JobManager } from '@pepper/core/jobs/manager.js';
import type { EngineRegistry } from '@pepper/core/engines/engine.js';
import type { ImageService } from './services/image.js';
import type { UpscaleService } from './services/upscale.js';
import type { PythonVideoService } from './services/python-video.js';
import type { CharacterService } from './services/characters.js';
import type { ResourceMonitor } from '@pepper/core/services/resources.js';
import type { StorageMonitor } from '@pepper/core/services/storage.js';
import type { ActivityTracker } from '@pepper/core/services/activity.js';

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
    backends: PepperBackendManager;
    models: ModelManager;
    catalogue: CatalogueManager;
    downloads: PepperDownloadManager;
    snapshotDownloads: SnapshotDownloader;
    jobs: JobManager;
    engines: EngineRegistry;
    images: ImageService;
    upscaler: UpscaleService;
    pythonVideo: PythonVideoService;
    characters: CharacterService;
    resources: ResourceMonitor;
    storage: StorageMonitor;
    activity: ActivityTracker;
    appVersion: string;
  }
}

export {};
