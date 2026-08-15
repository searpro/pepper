import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { downloads, type DownloadRow } from '../db/schema.js';
import { AppError, errors } from '../errors.js';
import type { ModelKind } from '../paths.js';
import type { ModelManager } from '../models/manager.js';
import { parseSlot, type ComponentSlot } from '../models/bundle.js';
import { gatedHint, hfAuthHeaders, isHuggingFaceUrl } from '../util/hf.js';

/**
 * The unified download manager (requirement 8).
 *
 * "Unified download manager for all types of weights" — sd-api ran three
 * separate `DownloadManager` instances, one per model domain, each with its
 * own allowed-extension rules and its own copy of the task table. Here there
 * is one manager and one table; the *destination* varies by `(kind, bundle,
 * slot)`, which is a parameter, not a class.
 *
 * Two behaviours are worth stating because they are what make abort/retry
 * useful rather than nominal:
 *
 * - **Cancel keeps the partial file.** A 40GB checkpoint interrupted at 39GB
 *   should resume, not restart. `.part` stays on disk with a `.part.json`
 *   sidecar recording the URL and expected size, so a resume works even after
 *   the server has restarted and lost every in-memory task.
 * - **Tasks are persisted.** sd-api kept them in memory, so a restart — which
 *   the process manager now performs on its own when a backend misbehaves —
 *   silently orphaned every in-flight download: the bytes were on disk, but
 *   nothing in the UI knew they were resumable.
 */

export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface DownloadTask {
  id: string;
  kind: ModelKind;
  bundle: string;
  slot: ComponentSlot;
  name: string;
  url: string;
  status: DownloadStatus;
  /** Bytes on disk, including any resumed prefix. */
  received: number;
  /** Expected total, or null when the server did not report one. */
  total: number | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  kind: ModelKind;
  bundle: string;
  slot: ComponentSlot;
  url: string;
  /** Explicit filename; otherwise derived from the URL. */
  name?: string;
}

interface SidecarMeta {
  url: string;
  total: number | null;
  kind: ModelKind;
  bundle: string;
  slot: string;
  name: string;
}

const PROGRESS_INTERVAL_MS = 400;
const ACTIVE: DownloadStatus[] = ['queued', 'downloading'];

export class DownloadManager extends EventEmitter {
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiting: string[] = [];
  private active = 0;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly models: ModelManager,
    private readonly log: FastifyBaseLogger,
    /** Fired whenever a download settles, so backends can pick up new models. */
    private readonly onSettle?: (task: DownloadTask) => void,
  ) {
    super();
    this.setMaxListeners(0);
  }

  /**
   * Reconcile persisted state at startup: anything the previous process left
   * mid-flight is marked failed-but-resumable rather than left claiming to be
   * downloading, which would show a progress bar that never moves.
   */
  recoverInterrupted(): number {
    const interrupted = this.db
      .update(downloads)
      .set({
        status: 'failed',
        error: 'Interrupted by a server restart — retry to resume',
        updatedAt: Date.now(),
      })
      .where(inArray(downloads.status, ACTIVE))
      .returning()
      .all();

    if (interrupted.length > 0) {
      this.log.info({ count: interrupted.length }, 'marked interrupted downloads as resumable');
    }
    return interrupted.length;
  }

  async enqueue(input: EnqueueInput): Promise<DownloadTask> {
    const slot = parseSlot(input.slot);
    const name = this.models.fileNameFor(input.url, input.name);

    // The same file already downloading is the same download — a double-click
    // in the catalogue UI must not produce two writers on one `.part` file.
    const existing = this.db
      .select()
      .from(downloads)
      .where(
        and(
          eq(downloads.kind, input.kind),
          eq(downloads.bundle, input.bundle),
          eq(downloads.component, slot),
          eq(downloads.name, name),
          inArray(downloads.status, ACTIVE),
        ),
      )
      .get();
    if (existing) return toTask(existing);

    const now = Date.now();
    const row: DownloadRow = {
      id: randomUUID(),
      kind: input.kind,
      bundle: input.bundle,
      component: slot,
      name,
      url: input.url,
      status: 'queued',
      received: 0,
      total: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(downloads).values(row).run();

    // Creating the slot directory here rather than at write time means the
    // bundle shows up in the model list immediately, with the download visible
    // against it, instead of appearing only once the first byte lands.
    await this.models.componentPaths(input.kind, input.bundle, slot, name);

    const task = toTask(row);
    this.log.info({ id: task.id, bundle: task.bundle, name }, 'download queued');
    this.emit('task', task);
    this.pump();
    return task;
  }

  list(filter: { kind?: ModelKind; bundle?: string; status?: DownloadStatus[] } = {}): DownloadTask[] {
    const conditions = [];
    if (filter.kind) conditions.push(eq(downloads.kind, filter.kind));
    if (filter.bundle) conditions.push(eq(downloads.bundle, filter.bundle));
    if (filter.status?.length) conditions.push(inArray(downloads.status, filter.status));

    const rows = this.db
      .select()
      .from(downloads)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(downloads.createdAt))
      .all();
    return rows.map(toTask);
  }

  get(id: string): DownloadTask | null {
    const row = this.db.select().from(downloads).where(eq(downloads.id, id)).get();
    return row ? toTask(row) : null;
  }

  /** Abort a queued or running download, keeping the partial file. */
  cancel(id: string): DownloadTask {
    const task = this.get(id);
    if (!task) throw errors.downloadNotFound(id);

    if (task.status === 'queued') {
      const index = this.waiting.indexOf(id);
      if (index >= 0) this.waiting.splice(index, 1);
      return this.settle(id, 'cancelled', 'Cancelled');
    }
    if (task.status === 'downloading') {
      this.controllers.get(id)?.abort();
      return task;
    }
    return task;
  }

  /** Retry a failed or cancelled download; resumes from its `.part`. */
  retry(id: string): DownloadTask {
    const task = this.get(id);
    if (!task) throw errors.downloadNotFound(id);
    if (task.status === 'downloading' || task.status === 'queued') return task;

    const updated = this.update(id, { status: 'queued', error: null });
    this.waiting.push(id);
    this.pump();
    return updated;
  }

  /** Delete the task record, and optionally the bytes already on disk. */
  async remove(id: string, discardPartial: boolean): Promise<void> {
    const task = this.get(id);
    if (!task) throw errors.downloadNotFound(id);

    if (task.status === 'downloading') this.controllers.get(id)?.abort();

    if (discardPartial) {
      const paths = await this.models.componentPaths(task.kind, task.bundle, task.slot, task.name);
      await unlink(paths.tmpPath).catch(() => {});
      await unlink(paths.metaPath).catch(() => {});
    }

    this.db.delete(downloads).where(eq(downloads.id, id)).run();
    this.emit('removed', { id });
  }

  /**
   * Resume a partial found by scanning the filesystem — the case where the
   * task record is gone (pruned, or the file was copied in from elsewhere) but
   * the `.part.json` sidecar still knows where the bytes came from.
   */
  async resumePartial(
    kind: ModelKind,
    bundle: string,
    slot: ComponentSlot,
    name: string,
  ): Promise<DownloadTask> {
    const paths = await this.models.componentPaths(kind, bundle, slot, name);
    let meta: SidecarMeta;
    try {
      meta = JSON.parse(await readFile(paths.metaPath, 'utf8')) as SidecarMeta;
    } catch {
      throw errors.downloadFailed(
        `Cannot resume "${name}": no resume metadata on disk. Download it again instead.`,
      );
    }
    return this.enqueue({ kind, bundle, slot, url: meta.url, name });
  }

  /** Subscribe to progress for one task, or to all tasks when `id` is omitted. */
  subscribe(id: string | null, listener: (event: string, task: DownloadTask) => void): () => void {
    const onProgress = (task: DownloadTask) => {
      if (!id || task.id === id) listener('progress', task);
    };
    const onSettled = (task: DownloadTask) => {
      if (!id || task.id === id) listener('done', task);
    };
    const onTask = (task: DownloadTask) => {
      if (!id || task.id === id) listener('task', task);
    };
    this.on('progress', onProgress);
    this.on('settled', onSettled);
    this.on('task', onTask);
    return () => {
      this.off('progress', onProgress);
      this.off('settled', onSettled);
      this.off('task', onTask);
    };
  }

  /** Re-queue everything left resumable — used at startup and by the UI. */
  resumeAll(): DownloadTask[] {
    const resumable = this.list({ status: ['failed', 'cancelled'] });
    return resumable.map((task) => this.retry(task.id));
  }

  private pump(): void {
    while (this.active < this.config.maxConcurrentDownloads) {
      const id = this.waiting.shift() ?? this.nextQueued();
      if (!id) return;
      const task = this.get(id);
      if (!task || task.status !== 'queued') continue;
      void this.run(task);
    }
  }

  private nextQueued(): string | null {
    const row = this.db
      .select()
      .from(downloads)
      .where(eq(downloads.status, 'queued'))
      .orderBy(downloads.createdAt)
      .limit(1)
      .get();
    return row?.id ?? null;
  }

  private update(id: string, patch: Partial<DownloadRow>): DownloadTask {
    const row = this.db
      .update(downloads)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(downloads.id, id))
      .returning()
      .get();
    return toTask(row);
  }

  private settle(id: string, status: DownloadStatus, error?: string): DownloadTask {
    const task = this.update(id, { status, error: error ?? null });
    this.emit('settled', task);
    this.onSettle?.(task);
    return task;
  }

  private async run(task: DownloadTask): Promise<void> {
    this.active++;
    this.update(task.id, { status: 'downloading', error: null });

    const controller = new AbortController();
    this.controllers.set(task.id, controller);

    try {
      const finished = await this.download(task, controller.signal);
      this.settle(task.id, 'completed');
      this.log.info({ id: task.id, name: task.name, bytes: finished }, 'download complete');
    } catch (err) {
      if (controller.signal.aborted) {
        this.settle(task.id, 'cancelled', 'Cancelled — partial file kept, retry to resume');
      } else {
        const message = err instanceof AppError ? err.message : (err as Error).message;
        this.settle(task.id, 'failed', message);
        this.log.warn({ id: task.id, err: message }, 'download failed');
      }
    } finally {
      this.controllers.delete(task.id);
      this.active--;
      this.pump();
    }
  }

  private async download(task: DownloadTask, signal: AbortSignal): Promise<number> {
    const paths = await this.models.componentPaths(task.kind, task.bundle, task.slot, task.name);

    let offset = 0;
    try {
      offset = (await stat(paths.tmpPath)).size;
    } catch {
      offset = 0;
    }

    const headers: Record<string, string> = {
      'User-Agent': 'pepper',
      ...hfAuthHeaders(task.url, this.config.hfToken),
    };
    if (offset > 0) headers.Range = `bytes=${offset}-`;

    const res = await fetch(task.url, { headers, signal, redirect: 'follow' });

    let append = false;
    let total: number | null = null;
    let received = 0;

    if (res.status === 416 && offset > 0) {
      // Range not satisfiable with a non-empty partial: the file is already
      // complete on disk and only the promotion never happened.
      await rename(paths.tmpPath, paths.finalPath);
      await unlink(paths.metaPath).catch(() => {});
      this.update(task.id, { received: offset, total: offset });
      return offset;
    }

    if (offset > 0 && res.status === 206) {
      append = true;
      received = offset;
      total = parseContentRangeTotal(res.headers.get('content-range'));
    } else if (res.ok) {
      // 200 means the server ignored the Range header (or there was nothing to
      // resume), so the existing partial is not a prefix of this response and
      // has to be discarded rather than appended to.
      append = false;
      received = 0;
      const length = res.headers.get('content-length');
      total = length ? Number(length) : null;
    } else if ((res.status === 401 || res.status === 403) && isHuggingFaceUrl(task.url)) {
      throw errors.downloadFailed(gatedHint(res.status));
    } else {
      throw errors.downloadFailed(`HTTP ${res.status} ${res.statusText}`);
    }

    if (!res.body) throw errors.downloadFailed('Empty response body');

    this.update(task.id, { received, total });

    const meta: SidecarMeta = {
      url: task.url,
      total,
      kind: task.kind,
      bundle: task.bundle,
      slot: task.slot,
      name: task.name,
    };
    await writeFile(paths.metaPath, JSON.stringify(meta), 'utf8').catch(() => {});

    let lastEmit = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, callback) => {
        received += chunk.length;
        const now = Date.now();
        // Throttled: a fast link delivers thousands of chunks a second, and a
        // database write plus an SSE frame per chunk would cost more than the
        // download.
        if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now;
          this.emit('progress', this.update(task.id, { received, total }));
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(paths.tmpPath, { flags: append ? 'a' : 'w' }),
      { signal },
    );

    // The `.part` becomes the real file only here, so an interrupted download
    // can never be mistaken for a complete component by the filesystem scan.
    await rename(paths.tmpPath, paths.finalPath);
    await unlink(paths.metaPath).catch(() => {});
    this.update(task.id, { received, total: total ?? received });
    return received;
  }
}

function toTask(row: DownloadRow): DownloadTask {
  return {
    id: row.id,
    kind: row.kind as ModelKind,
    bundle: row.bundle,
    slot: row.component as ComponentSlot,
    name: row.name,
    url: row.url,
    status: row.status as DownloadStatus,
    received: row.received,
    total: row.total,
    error: row.error ?? undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? Number(m[1]) : null;
}
