import type { ComponentSlot } from '../models/bundle.js';
import type { ModelKind } from '../paths.js';
import type { DownloadManager, DownloadTask } from '@pepper/core/downloads/manager.js';

export {
  DownloadManager,
  type DownloadStatus,
  type EnqueueInput,
} from '@pepper/core/downloads/manager.js';

/**
 * Pepper files downloads under `models/<kind>/<bundle>/<slot>/`; its
 * `ModelManager` is the layout (see `core/downloads/manager.ts`).
 */
export type PepperDownloadManager = DownloadManager<ModelKind, ComponentSlot>;
export type PepperDownloadTask = DownloadTask<ModelKind, ComponentSlot>;
