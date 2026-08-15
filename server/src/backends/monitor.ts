import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Sample a running process's memory (requirement 5: "kill and restart the
 * process if the process is swapping or the process is idle for long time and
 * consuming memory. Currently the audio-cpp-server is swapping.").
 *
 * Swap is the signal that matters, and it is not the same as high memory use.
 * A backend holding 12GB resident is doing its job. A backend whose pages the
 * kernel has pushed to disk is in the failure mode that produced this
 * requirement: every subsequent inference faults those pages back in, so a
 * request that took two seconds takes ninety, and the process never recovers
 * on its own because nothing shrinks its footprint. Watching RSS alone cannot
 * tell those apart — only `VmSwap` can.
 *
 * On Linux that comes from `/proc/<pid>/status`, which is exact and free.
 * macOS has no per-process swap accounting available without elevated
 * privileges, so `swapKb` is reported as `null` there and the idle-memory rule
 * carries the load instead; production is Linux/CUDA, so the precise signal is
 * available where it is actually needed.
 */

export interface ProcessStats {
  pid: number;
  /** Resident set size in KiB. */
  rssKb: number;
  /** Swapped-out memory in KiB, or `null` where the platform cannot report it. */
  swapKb: number | null;
}

export async function sampleProcess(pid: number): Promise<ProcessStats | null> {
  return process.platform === 'linux' ? sampleLinux(pid) : samplePs(pid);
}

async function sampleLinux(pid: number): Promise<ProcessStats | null> {
  let content: string;
  try {
    content = await readFile(`/proc/${pid}/status`, 'utf8');
  } catch {
    // The process exited between the caller's check and this read.
    return null;
  }

  const rssKb = matchKb(content, 'VmRSS');
  const swapKb = matchKb(content, 'VmSwap');
  if (rssKb === null) return null;
  // VmSwap is absent on kernels built without swap accounting; absent is not
  // the same as zero, so it stays null rather than claiming "no swap".
  return { pid, rssKb, swapKb };
}

function matchKb(status: string, field: string): number | null {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(status);
  return m ? Number(m[1]) : null;
}

async function samplePs(pid: number): Promise<ProcessStats | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: 5000,
    });
    const rssKb = Number(stdout.trim());
    if (!Number.isFinite(rssKb)) return null;
    return { pid, rssKb, swapKb: null };
  } catch {
    return null;
  }
}

/** Total system memory in KiB, used to express thresholds as a fraction. */
export async function totalMemoryKb(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const meminfo = await readFile('/proc/meminfo', 'utf8');
      const total = matchKb(meminfo, 'MemTotal');
      if (total) return total;
    } catch {
      // fall through to the os module
    }
  }
  const { totalmem } = await import('node:os');
  return Math.round(totalmem() / 1024);
}

export interface HealthPolicy {
  /** Restart once swap exceeds this many KiB. `null` disables the swap rule. */
  swapLimitKb: number | null;
  /** Restart when idle this long *and* holding more than `idleRssLimitKb`. */
  idleAfterMs: number;
  idleRssLimitKb: number;
}

export interface PolicyVerdict {
  restart: boolean;
  reason?: string;
}

/**
 * Decide whether a sampled process should be recycled.
 *
 * The idle rule is deliberately conjunctive: idleness alone is not a problem
 * (a backend sitting ready for the next request is the desired state), and
 * memory use alone is not either. It is holding gigabytes *while doing
 * nothing* that is worth reclaiming — and a restart is cheap precisely because
 * nothing is in flight.
 */
export function evaluatePolicy(
  stats: ProcessStats,
  idleForMs: number,
  policy: HealthPolicy,
): PolicyVerdict {
  if (policy.swapLimitKb !== null && stats.swapKb !== null && stats.swapKb > policy.swapLimitKb) {
    return {
      restart: true,
      reason: `swapping (${mib(stats.swapKb)} MiB swapped, limit ${mib(policy.swapLimitKb)} MiB)`,
    };
  }
  if (idleForMs >= policy.idleAfterMs && stats.rssKb > policy.idleRssLimitKb) {
    return {
      restart: true,
      reason: `idle ${Math.round(idleForMs / 1000)}s holding ${mib(stats.rssKb)} MiB (limit ${mib(policy.idleRssLimitKb)} MiB)`,
    };
  }
  return { restart: false };
}

function mib(kb: number): number {
  return Math.round(kb / 1024);
}
