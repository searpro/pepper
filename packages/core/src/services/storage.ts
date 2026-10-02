import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { errors } from '../errors.js';

const execFileAsync = promisify(execFile);

/** Kept free for the database, logs, uploads and a runner's virtualenv. */
const RESERVE_BYTES = 2 * 1024 ** 3;
/** `du` over a network volume takes seconds; a status poll must not wait on it. */
const MAX_AGE_MS = 60_000;

/**
 * A volume size in RunPod's gigabytes as bytes. They are decimal: a 100 GB
 * volume refused writes at about 100e9 bytes, so counting it as 100 GiB
 * (7 % more) let downloads that did not fit pass the room check.
 */
export function volumeBytes(gb: number): number {
  return gb * 1e9;
}

export interface StorageSnapshot {
  /** Null until the first measurement finishes. */
  usedBytes: number | null;
  totalBytes: number;
}

/** How full the data volume is, for a storage indicator. */
export interface StorageUsage {
  /** Null until the first measurement of a quota finishes. */
  usedBytes: number | null;
  totalBytes: number;
  freeBytes: number | null;
  /** `quota`: DATA_VOLUME_GB, measured with `du`; `filesystem`: what `statfs` reports. */
  source: 'quota' | 'filesystem';
}

/**
 * How full the data volume is, for volumes whose limit the filesystem does
 * not report.
 *
 * A RunPod network volume is a quota on a shared filesystem: `statfs` answers
 * with the whole cluster (petabytes free), and the first sign of a full volume
 * is a write failing with "Disk quota exceeded". That has cost a session
 * twice — once a download corrupted the database mid-write, once the next boot
 * died with SIGBUS before logging a line. So the limit is configured
 * (`DATA_VOLUME_GB`, which the RunPod launcher sets from the volume's size),
 * usage is measured with `du`, and a download that would not fit is refused
 * before its first byte rather than failing at its last.
 *
 * With no limit configured every method is a no-op.
 */
export class StorageMonitor {
  private measured: { bytes: number; at: number } | null = null;
  private inFlight: Promise<number | null> | null = null;

  constructor(
    private readonly dir: string,
    private readonly limitBytes: number | null,
  ) {}

  get limited(): boolean {
    return this.limitBytes !== null;
  }

  /** The last measurement, refreshed in the background when stale. Never waits. */
  snapshot(): StorageSnapshot | null {
    if (this.limitBytes === null) return null;
    if (!this.measured || Date.now() - this.measured.at > MAX_AGE_MS) void this.measure();
    return { usedBytes: this.measured?.bytes ?? null, totalBytes: this.limitBytes };
  }

  /**
   * Used, total and free space for display, never waiting on `du`. Without a
   * configured limit (a local disk, whose size the filesystem does report)
   * this is `statfs`; null if even that fails.
   */
  async usage(): Promise<StorageUsage | null> {
    const snapshot = this.snapshot();
    if (snapshot) {
      const { usedBytes, totalBytes } = snapshot;
      return { usedBytes, totalBytes, freeBytes: usedBytes === null ? null : Math.max(0, totalBytes - usedBytes), source: 'quota' };
    }
    try {
      const fs = await statfs(this.dir);
      const totalBytes = fs.blocks * fs.bsize;
      return { usedBytes: totalBytes - fs.bfree * fs.bsize, totalBytes, freeBytes: fs.bavail * fs.bsize, source: 'filesystem' };
    } catch {
      return null;
    }
  }

  /** Forget the measurement: a model was installed or deleted. */
  invalidate(): void {
    this.measured = null;
  }

  /**
   * Throw unless `bytes` more fit. `alsoPending` is what other downloads
   * already under way have still to write, which `du` cannot see yet.
   */
  async assertRoom(bytes: number, alsoPending = 0, what = 'this file'): Promise<void> {
    if (this.limitBytes === null) return;
    // Always a fresh figure: the cached one may predate a download or a delete.
    this.measured = null;
    const used = await this.measure();
    if (used === null) return; // no `du`; nothing to judge by
    const free = this.limitBytes - RESERVE_BYTES - used - alsoPending;
    if (bytes > free) {
      throw errors.downloadFailed(
        `Not enough room on the data volume: ${what} needs ${gb(bytes)} and ${gb(Math.max(0, free))} is free ` +
          `(${gb(used)} used of ${gb(this.limitBytes)}${alsoPending ? `, ${gb(alsoPending)} more already queued` : ''}). ` +
          'Delete a model first, or grow the volume.',
      );
    }
  }

  private measure(): Promise<number | null> {
    if (this.measured && Date.now() - this.measured.at <= MAX_AGE_MS) return Promise.resolve(this.measured.bytes);
    this.inFlight ??= execFileAsync('du', ['-sk', this.dir], { timeout: 120_000 })
      .then(({ stdout }) => {
        const kb = Number(stdout.trim().split(/\s+/)[0]);
        if (!Number.isFinite(kb)) return null;
        this.measured = { bytes: kb * 1024, at: Date.now() };
        return this.measured.bytes;
      })
      // `du` exits non-zero when a file vanishes mid-walk; its total is still printed.
      .catch((err: { stdout?: string }) => {
        const kb = Number(String(err.stdout ?? '').trim().split(/\s+/)[0]);
        if (!Number.isFinite(kb) || kb === 0) return null;
        this.measured = { bytes: kb * 1024, at: Date.now() };
        return this.measured.bytes;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/** Decimal, like the limit itself (`volumeBytes`) and the hosts' own figures. */
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}
