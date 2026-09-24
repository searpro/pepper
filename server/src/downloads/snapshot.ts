import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { slotDirName, type ComponentSlot } from '../models/bundle.js';
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
  /**
   * Land the snapshot inside this component slot (`checkpoint`, `other:foo`,
   * …) rather than at the bundle root. Needed for a bundle assembled from
   * several whole-repo snapshots — EchoMimicV3's base model, audio encoder
   * and transformer weights each need their own directory, unlike a vLLM
   * bundle, which *is* the one repo it serves.
   */
  slot?: ComponentSlot;
  /** Pull only this sub-folder of `repo`, e.g. "transformer". */
  path?: string;
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

  async enqueue(
    kind: ModelKind,
    bundle: string,
    repo: string,
    opts: { slot?: ComponentSlot; path?: string } = {},
  ): Promise<SnapshotTask> {
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
      slot: opts.slot,
      path: opts.path,
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

  private targetDir(task: SnapshotTask): string {
    const bundle = bundleDir(this.paths, task.kind, task.bundle);
    return task.slot ? join(bundle, slotDirName(task.slot)) : bundle;
  }

  private run(task: SnapshotTask): void {
    const dir = this.targetDir(task);
    const token = resolveHfToken(this.hfToken);

    this.log.info({ id: task.id, repo: task.repo, path: task.path, dir }, 'snapshot download started');

    const args = ['download', task.repo, '--local-dir', dir];
    // `--include` keeps the download to one sub-folder of the repo — the
    // shape EchoMimicV3's `transformer/` component needs, unlike a vLLM
    // bundle where the whole repo is the model.
    if (task.path) args.push('--include', `${task.path}/*`);

    const child = spawn('huggingface-cli', args, {
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
      if (code !== 0) {
        this.settle(task.id, 'failed', `huggingface-cli exited with code ${code}`);
        return;
      }
      // `--include "<path>/*"` still mirrors the repo's own layout under
      // `--local-dir`, landing files at `<dir>/<path>/…` instead of `<dir>/…`.
      // The component's slot directory is supposed to *be* that content, the
      // same way a plain component download's slot directory holds the file
      // directly rather than a repo-shaped wrapper around it — so the
      // sub-folder is flattened up into the slot directory once the pull
      // finishes.
      (task.path ? flattenSnapshotPath(dir, task.path) : Promise.resolve())
        .then(() => this.settle(task.id, 'completed'))
        .catch((err) => this.settle(task.id, 'failed', `Could not flatten "${task.path}": ${(err as Error).message}`));
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

/**
 * `huggingface-cli download --include "<subpath>/*" --local-dir <dir>` still
 * mirrors the repo's own layout under `dir`, landing files at
 * `<dir>/<subpath>/…` rather than `<dir>/…`. A component's slot directory is
 * supposed to *be* that content — the same way a plain single-file component
 * download's slot directory holds the file directly, not a repo-shaped
 * wrapper around it — so this moves `<dir>/<subpath>`'s contents up into
 * `dir` and removes the now-empty sub-folder chain.
 *
 * Exported standalone (rather than a private method) so this filesystem dance
 * — easy to get subtly wrong on a multi-segment `subpath` — is testable
 * without spawning `huggingface-cli`.
 */
export async function flattenSnapshotPath(dir: string, subpath: string): Promise<void> {
  const nested = join(dir, subpath);
  const entries = await readdir(nested).catch(() => null);
  if (!entries) return; // Nothing downloaded under that path — leave it as-is for the caller to notice.
  for (const entry of entries) {
    await rename(join(nested, entry), join(dir, entry));
  }
  // Remove the now-empty directory chain (`nested` and, for a multi-segment
  // `subpath`, its now-empty parents up to `dir`), innermost first.
  let cursor = nested;
  while (cursor !== dir) {
    await rmdir(cursor).catch(() => {}); // Not empty (a sibling file collided) or already gone — leave it.
    cursor = join(cursor, '..');
  }
}
