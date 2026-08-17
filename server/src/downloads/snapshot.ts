import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import { bundleDir, type ModelKind, type Paths } from '../paths.js';
import type { ModelManager } from '../models/manager.js';
import { resolveHfToken } from '../util/hf.js';
import { errors } from '../errors.js';

/**
 * Whole-repo HuggingFace snapshot downloads, for vLLM models (requirement:
 * "derive a mechanism to handle snapshot downloads from huggingface").
 *
 * Deliberately not the SQLite-backed `DownloadManager`: that table models one
 * row per *single file*, with its own byte-range resume math. A vLLM repo is
 * typically dozens of files (config.json, tokenizer, sharded safetensors)
 * with no one weight file to point a component slot at, and reimplementing
 * multi-file resume/checksum logic is exactly what `huggingface-cli download`
 * (backed by `hf_transfer`, already a vLLM dependency baked into the image)
 * already does — see the requirements doc's own suggestion to prefer
 * delegating over rebuilding it. So this shells out and tracks the process,
 * in memory only: a retry after a restart just re-invokes the CLI, which
 * resumes from its own `~/.cache/huggingface` rather than anything pepper
 * tracks.
 */

export type SnapshotStatus = 'downloading' | 'completed' | 'failed';

export interface SnapshotTask {
  id: string;
  kind: ModelKind;
  bundle: string;
  repo: string;
  status: SnapshotStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Tail of huggingface-cli's own stdout/stderr, since it has no numeric progress API. */
  recentOutput: string[];
}

const OUTPUT_TAIL = 50;

export class SnapshotDownloader extends EventEmitter {
  private readonly tasks = new Map<string, SnapshotTask>();

  constructor(
    private readonly paths: Paths,
    private readonly models: ModelManager,
    private readonly hfToken: string | undefined,
    private readonly log: FastifyBaseLogger,
  ) {
    super();
    this.setMaxListeners(0);
  }

  list(): SnapshotTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): SnapshotTask | null {
    return this.tasks.get(id) ?? null;
  }

  async enqueue(kind: ModelKind, bundle: string, repo: string): Promise<SnapshotTask> {
    // Registers the bundle directory (and, for a first-time model id, its
    // model.json) so it shows up in the model list immediately, the same
    // reasoning `DownloadManager.enqueue` uses for single-file components.
    await this.models.create(kind, bundle).catch(() => {
      // Already exists — fine, this is also how a re-download of an existing
      // bundle reaches here.
    });

    const now = new Date().toISOString();
    const task: SnapshotTask = {
      id: randomUUID(),
      kind,
      bundle,
      repo,
      status: 'downloading',
      createdAt: now,
      updatedAt: now,
      recentOutput: [],
    };
    this.tasks.set(task.id, task);
    this.emit('task', task);
    this.run(task);
    return task;
  }

  private run(task: SnapshotTask): void {
    const dir = bundleDir(this.paths, task.kind, task.bundle);
    const token = resolveHfToken(this.hfToken);

    this.log.info({ id: task.id, repo: task.repo, dir }, 'snapshot download started');

    const child = spawn('huggingface-cli', ['download', task.repo, '--local-dir', dir], {
      env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) },
    });

    const onOutput = (buf: Buffer) => {
      const current = this.tasks.get(task.id);
      if (!current) return;
      const line = buf.toString('utf8').trim();
      if (!line) return;
      current.recentOutput.push(line);
      if (current.recentOutput.length > OUTPUT_TAIL) current.recentOutput.shift();
      current.updatedAt = new Date().toISOString();
      this.emit('progress', current);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      const message =
        e.code === 'ENOENT'
          ? 'huggingface-cli not found — expected to be baked into the image alongside vLLM'
          : `Failed to start huggingface-cli: ${e.message}`;
      this.settle(task.id, 'failed', message);
    });
    child.on('exit', (code) => {
      if (code === 0) this.settle(task.id, 'completed');
      else this.settle(task.id, 'failed', `huggingface-cli exited with code ${code}`);
    });
  }

  private settle(id: string, status: SnapshotStatus, error?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
    task.error = error;
    task.updatedAt = new Date().toISOString();
    if (status === 'completed') {
      this.log.info({ id, repo: task.repo }, 'snapshot download complete');
    } else {
      this.log.warn({ id, repo: task.repo, error }, 'snapshot download failed');
    }
    this.emit('settled', task);
  }

  /** Subscribe to progress for one task, or every task when `id` is omitted. */
  subscribe(id: string | null, listener: (event: string, task: SnapshotTask) => void): () => void {
    const relay = (event: string) => (task: SnapshotTask) => {
      if (!id || task.id === id) listener(event, task);
    };
    const onProgress = relay('progress');
    const onSettled = relay('settled');
    const onTask = relay('task');
    this.on('progress', onProgress);
    this.on('settled', onSettled);
    this.on('task', onTask);
    return () => {
      this.off('progress', onProgress);
      this.off('settled', onSettled);
      this.off('task', onTask);
    };
  }

  require(id: string): SnapshotTask {
    const task = this.get(id);
    if (!task) throw errors.downloadNotFound(id);
    return task;
  }
}
