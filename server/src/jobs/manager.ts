import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { jobs, type JobRow } from '../db/schema.js';
import { AppError, errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import { Semaphore } from '../util/semaphore.js';
import type { StepProgress } from '../logs/parse.js';

/**
 * The job queue (requirement 4: "Follow the current architectural patterns
 * used in sd-api. Should support abort/retry/delete").
 *
 * Two changes from sd-api's version, both forced by the other requirements:
 *
 * - **Jobs are persisted.** They have to be, now that the process manager can
 *   restart a backend on its own: a queue that lives only in memory loses
 *   everything queued behind the job that triggered the restart, and the user
 *   sees work silently vanish. Retry in particular is meaningless without the
 *   original parameters still being on disk.
 * - **Executors are registered, not hardcoded.** sd-api's `JobManager` held a
 *   direct reference to `SdWrapper` and could therefore only ever run image
 *   generations. Here a job carries a `kind` and the service that knows how to
 *   run that kind registers itself, which is what lets audio and text
 *   generations share one queue, one concurrency budget and one abort path.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'image' | 'video' | 'audio' | 'text';

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  step?: number;
  totalSteps?: number;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  onProgress: (progress: StepProgress) => void;
  onLog: (line: string) => void;
}

/** Runs one job of a given kind and returns whatever the client should see. */
export type JobExecutor = (context: JobContext) => Promise<Record<string, unknown>>;

const ACTIVE: JobStatus[] = ['queued', 'running'];

export class JobManager extends EventEmitter {
  private readonly executors = new Map<JobKind, JobExecutor>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly slots: Semaphore;
  private draining = false;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {
    super();
    this.setMaxListeners(0);
    this.slots = new Semaphore(config.maxConcurrentJobs);
  }

  registerExecutor(kind: JobKind, executor: JobExecutor): void {
    this.executors.set(kind, executor);
  }

  /**
   * Reconcile persisted state at startup. A job recorded as running cannot
   * still be running — its process died with the server — so it is failed with
   * a message that says so, and left retryable. Queued jobs are genuinely
   * still queued and are picked back up.
   */
  recoverInterrupted(): { failed: number; requeued: number } {
    const now = Date.now();
    const failed = this.db
      .update(jobs)
      .set({
        status: 'failed',
        error: { code: 'GENERATION_FAILED', message: 'Interrupted by a server restart' },
        finishedAt: now,
      })
      .where(eq(jobs.status, 'running'))
      .returning()
      .all();

    const queued = this.db.select().from(jobs).where(eq(jobs.status, 'queued')).all();

    if (failed.length || queued.length) {
      this.log.info({ failed: failed.length, requeued: queued.length }, 'recovered interrupted jobs');
    }
    // Kick the queue once executors have had a chance to register.
    setImmediate(() => this.pump());
    return { failed: failed.length, requeued: queued.length };
  }

  create(kind: JobKind, params: Record<string, unknown>): Job {
    const row: JobRow = {
      id: randomUUID(),
      kind,
      status: 'queued',
      progress: 0,
      step: null,
      totalSteps: null,
      params,
      result: null,
      error: null,
      attempts: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.db.insert(jobs).values(row).run();

    const job = toJob(row);
    this.log.info({ jobId: job.id, kind }, 'job queued');
    this.logs.push({ level: 'info', source: 'job', msg: `${kind} job queued`, fields: { jobId: job.id } });
    this.emit('created', job);
    this.pump();
    return job;
  }

  get(id: string): Job | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  require(id: string): Job {
    const job = this.get(id);
    if (!job) throw errors.jobNotFound(id);
    return job;
  }

  list(filter: { kind?: JobKind; status?: JobStatus[]; limit?: number } = {}): Job[] {
    const conditions = [];
    if (filter.kind) conditions.push(eq(jobs.kind, filter.kind));
    if (filter.status?.length) conditions.push(inArray(jobs.status, filter.status));

    return this.db
      .select()
      .from(jobs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(filter.limit ?? 200)
      .all()
      .map(toJob);
  }

  /** Abort a queued or running job. */
  cancel(id: string): Job {
    const job = this.require(id);

    if (job.status === 'queued') {
      return this.finish(id, 'cancelled', {
        error: { code: 'GENERATION_FAILED', message: 'Cancelled before it started' },
      });
    }
    if (job.status === 'running') {
      // The executor owns cancellation from here: aborting the signal kills
      // the child process, and `runJob`'s catch records the outcome. Marking
      // it cancelled here instead would leave a process running against a job
      // the UI already shows as stopped.
      this.controllers.get(id)?.abort();
      return job;
    }
    return job;
  }

  /** Re-run a finished job with its original parameters. */
  retry(id: string): Job {
    const job = this.require(id);
    if (job.status === 'queued' || job.status === 'running') {
      throw errors.jobConflict(`Job ${id} is still ${job.status}`);
    }

    const updated = this.update(id, {
      status: 'queued',
      progress: 0,
      step: null,
      totalSteps: null,
      result: null,
      error: null,
      attempts: job.attempts + 1,
      startedAt: null,
      finishedAt: null,
    });
    this.emit('updated', updated);
    this.pump();
    return updated;
  }

  /** Remove a job record, aborting it first if it is still running. */
  remove(id: string): void {
    const job = this.require(id);
    if (job.status === 'running') this.controllers.get(id)?.abort();
    this.db.delete(jobs).where(eq(jobs.id, id)).run();
    this.emit('removed', { id });
  }

  /** Drop finished jobs older than `olderThanMs`. */
  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const removed = this.db
      .delete(jobs)
      .where(
        and(
          inArray(jobs.status, ['completed', 'failed', 'cancelled']),
          lt(jobs.createdAt, cutoff),
        ),
      )
      .returning()
      .all();
    return removed.length;
  }

  /** Subscribe to one job's events, or to every job when `id` is null. */
  subscribe(id: string | null, listener: (event: string, data: unknown) => void): () => void {
    // Every event payload carries the job's id as either `id` (a job object)
    // or `jobId` (a progress/log tick), so one filter covers both shapes.
    const relay = (event: string) => (...args: unknown[]) => {
      const data = args[0] as { id?: string; jobId?: string } | undefined;
      if (id && data?.id !== id && data?.jobId !== id) return;
      listener(event, data);
    };

    const handlers: [string, (...args: unknown[]) => void][] = [
      ['created', relay('created')],
      ['updated', relay('updated')],
      ['progress', relay('progress')],
      ['log', relay('log')],
      ['completed', relay('completed')],
      ['failed', relay('failed')],
      ['removed', relay('removed')],
    ];
    for (const [event, handler] of handlers) this.on(event, handler);
    return () => {
      for (const [event, handler] of handlers) this.off(event, handler);
    };
  }

  stats(): { running: number; queued: number; capacity: number } {
    return {
      running: this.slots.inUse,
      queued: this.db.select().from(jobs).where(eq(jobs.status, 'queued')).all().length,
      capacity: this.slots.capacity,
    };
  }

  /** Apply a runtime change to `MAX_CONCURRENT_JOBS`. */
  setConcurrency(limit: number): void {
    this.slots.resize(limit);
    this.pump();
  }

  private update(id: string, patch: Partial<JobRow>): Job {
    const row = this.db.update(jobs).set(patch).where(eq(jobs.id, id)).returning().get();
    return toJob(row);
  }

  private finish(id: string, status: JobStatus, patch: Partial<JobRow> = {}): Job {
    const job = this.update(id, { ...patch, status, finishedAt: Date.now() });
    this.emit(status === 'completed' ? 'completed' : 'failed', job);
    this.emit('updated', job);
    return job;
  }

  /**
   * Start as many queued jobs as there are free slots.
   *
   * `draining` guards against re-entry: `runJob` releases its slot and calls
   * `pump()` from its own `finally`, so without it a completing job could
   * recurse into a pump already walking the queue and dispatch the same row
   * twice.
   */
  private pump(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.slots.inUse + this.slots.queued < this.slots.capacity) {
        const row = this.db
          .select()
          .from(jobs)
          .where(eq(jobs.status, 'queued'))
          .orderBy(jobs.createdAt)
          .limit(1)
          .get();
        if (!row) return;

        // Claim it synchronously — better-sqlite3 is synchronous, so this
        // write completes before the loop can select the same row again.
        const claimed = this.update(row.id, { status: 'running', startedAt: Date.now() });
        void this.runJob(claimed);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    const executor = this.executors.get(job.kind);
    if (!executor) {
      this.finish(job.id, 'failed', {
        error: { code: 'UNSUPPORTED', message: `No executor registered for "${job.kind}" jobs` },
      });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.emit('updated', job);
    this.log.info({ jobId: job.id, kind: job.kind }, 'job running');

    try {
      await this.slots.run(async () => {
        const result = await executor({
          job,
          signal: controller.signal,
          onProgress: (progress) => {
            const updated = this.update(job.id, {
              progress: progress.progress,
              step: progress.step,
              totalSteps: progress.total,
            });
            this.emit('progress', { jobId: job.id, ...progress });
            this.emit('updated', updated);
          },
          onLog: (line) => this.emit('log', { jobId: job.id, line }),
        });

        this.finish(job.id, 'completed', { progress: 1, result });
        this.log.info({ jobId: job.id }, 'job completed');
        this.logs.push({
          level: 'info',
          source: 'job',
          msg: `${job.kind} job completed`,
          fields: { jobId: job.id },
        });
      }, controller.signal);
    } catch (err) {
      const cancelled = controller.signal.aborted || (err as Error).name === 'AbortError';
      const appError =
        err instanceof AppError
          ? err
          : new AppError('GENERATION_FAILED', (err as Error).message, 500);

      this.finish(job.id, cancelled ? 'cancelled' : 'failed', {
        error: cancelled
          ? { code: 'GENERATION_FAILED', message: 'Cancelled' }
          : { code: appError.code, message: appError.message },
      });

      if (cancelled) {
        this.log.info({ jobId: job.id }, 'job cancelled');
      } else {
        this.log.warn({ jobId: job.id, err: appError.message }, 'job failed');
        this.logs.push({
          level: 'error',
          source: 'job',
          msg: `${job.kind} job failed: ${appError.message}`,
          fields: { jobId: job.id },
        });
      }
    } finally {
      this.controllers.delete(job.id);
      this.pump();
    }
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    progress: row.progress,
    step: row.step ?? undefined,
    totalSteps: row.totalSteps ?? undefined,
    params: (row.params ?? {}) as Record<string, unknown>,
    result: (row.result ?? undefined) as Record<string, unknown> | undefined,
    error: (row.error ?? undefined) as { code: string; message: string } | undefined,
    attempts: row.attempts,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : undefined,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : undefined,
  };
}
