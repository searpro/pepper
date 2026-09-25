import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, totalmem, freemem } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Host utilisation for the header meters: CPU, RAM, GPU and GPU memory.
 *
 * Every source here is one that works without elevated privileges, and every
 * one degrades to `null` rather than throwing — a box without `nvidia-smi` or
 * a GPU the probe does not recognise still gets CPU and RAM.
 *
 * - **CPU** is the busy fraction of all cores since the previous sample, from
 *   `os.cpus()` tick counters — the same number `top` reports, on every OS.
 * - **RAM** on Linux is `MemTotal - MemAvailable`. On macOS `os.freemem()`
 *   counts only never-touched pages and reads as "almost full" on any machine
 *   that has been up for an hour, so used memory is computed from `vm_stat`
 *   the way Activity Monitor does: app memory + wired + compressed.
 * - **GPU** on NVIDIA is `nvidia-smi` (summed across devices). On Apple
 *   Silicon it is the `IOAccelerator` performance counters from `ioreg`; GPU
 *   memory there is unified with RAM, so `unified` tells the UI to label it as
 *   the GPU's share of system memory rather than as separate VRAM.
 */

export interface GpuSnapshot {
  name: string;
  count: number;
  /** Busy percentage, 0–100, or null when the platform does not report it. */
  percent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  /** GPU memory is system RAM (Apple Silicon), not dedicated VRAM. */
  unified: boolean;
}

export interface ResourceSnapshot {
  sampledAt: string;
  cpu: { percent: number; cores: number };
  memory: { usedBytes: number; totalBytes: number };
  gpu: GpuSnapshot | null;
}

/** Samples closer together than this are served from the last one. */
const MIN_INTERVAL_MS = 1500;

export class ResourceMonitor {
  private lastCpu = cpuTicks();
  private cached: ResourceSnapshot | null = null;
  private inFlight: Promise<ResourceSnapshot> | null = null;
  /** Set once a probe has failed, so a missing tool is not re-spawned every poll. */
  private gpuProbe: 'nvidia' | 'apple' | 'none' | null = null;

  async sample(): Promise<ResourceSnapshot> {
    if (this.cached && Date.now() - Date.parse(this.cached.sampledAt) < MIN_INTERVAL_MS) {
      return this.cached;
    }
    // Several status polls landing together share one sample (and one
    // nvidia-smi spawn) rather than each running their own.
    this.inFlight ??= this.doSample().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doSample(): Promise<ResourceSnapshot> {
    const [memory, gpu] = await Promise.all([sampleMemory(), this.sampleGpu()]);
    const snapshot: ResourceSnapshot = {
      sampledAt: new Date().toISOString(),
      cpu: { percent: this.sampleCpu(), cores: cpus().length },
      memory,
      gpu,
    };
    this.cached = snapshot;
    return snapshot;
  }

  private sampleCpu(): number {
    const now = cpuTicks();
    const idle = now.idle - this.lastCpu.idle;
    const total = now.total - this.lastCpu.total;
    this.lastCpu = now;
    if (total <= 0) return 0;
    return round1(Math.min(100, Math.max(0, (1 - idle / total) * 100)));
  }

  private async sampleGpu(): Promise<GpuSnapshot | null> {
    if (this.gpuProbe === 'none') return null;

    if (this.gpuProbe !== 'apple') {
      const nvidia = await sampleNvidia();
      if (nvidia) {
        this.gpuProbe = 'nvidia';
        return nvidia;
      }
      if (this.gpuProbe === 'nvidia') return null; // transient failure; keep probing nvidia
    }

    if (process.platform === 'darwin') {
      const apple = await sampleApple();
      if (apple) {
        this.gpuProbe = 'apple';
        return apple;
      }
    }

    if (this.gpuProbe === null) this.gpuProbe = 'none';
    return null;
  }
}

function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function sampleMemory(): Promise<ResourceSnapshot['memory']> {
  const totalBytes = totalmem();

  if (process.platform === 'linux') {
    try {
      const meminfo = await readFile('/proc/meminfo', 'utf8');
      const available = kb(meminfo, 'MemAvailable');
      const total = kb(meminfo, 'MemTotal');
      if (available !== null && total !== null) {
        return { usedBytes: (total - available) * 1024, totalBytes: total * 1024 };
      }
    } catch {
      // fall through
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 3000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
      const pages = (label: string) => {
        const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(stdout);
        return m ? Number(m[1]) : null;
      };
      const anonymous = pages('Anonymous pages');
      const purgeable = pages('Pages purgeable') ?? 0;
      const active = pages('Pages active') ?? 0;
      const wired = pages('Pages wired down') ?? 0;
      const compressed = pages('Pages occupied by compressor') ?? 0;
      const app = anonymous !== null ? anonymous - purgeable : active;
      return { usedBytes: (app + wired + compressed) * pageSize, totalBytes };
    } catch {
      // fall through
    }
  }

  return { usedBytes: totalBytes - freemem(), totalBytes };
}

async function sampleNvidia(): Promise<GpuSnapshot | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.split(',').map((cell) => cell.trim()))
      .filter((cells) => cells.length >= 4);
    if (rows.length === 0) return null;

    const num = (value: string) => (Number.isFinite(Number(value)) ? Number(value) : null);
    const utils = rows.map((r) => num(r[1])).filter((v): v is number => v !== null);
    const used = rows.map((r) => num(r[2])).filter((v): v is number => v !== null);
    const total = rows.map((r) => num(r[3])).filter((v): v is number => v !== null);
    const MiB = 1024 * 1024;
    return {
      name: rows[0][0],
      count: rows.length,
      percent: utils.length ? round1(utils.reduce((a, b) => a + b, 0) / utils.length) : null,
      memoryUsedBytes: used.length ? used.reduce((a, b) => a + b, 0) * MiB : null,
      memoryTotalBytes: total.length ? total.reduce((a, b) => a + b, 0) * MiB : null,
      unified: false,
    };
  } catch {
    return null;
  }
}

async function sampleApple(): Promise<GpuSnapshot | null> {
  try {
    const { stdout } = await execFileAsync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stat = (label: string) => {
      const m = new RegExp(`"${label.replace(/[()%]/g, '\\$&')}"=(\\d+)`).exec(stdout);
      return m ? Number(m[1]) : null;
    };
    const percent = stat('Device Utilization %');
    const inUse = stat('In use system memory');
    if (percent === null && inUse === null) return null;
    const name = /"model" = "([^"]+)"/.exec(stdout)?.[1] ?? 'Apple GPU';
    return {
      name,
      count: 1,
      percent,
      memoryUsedBytes: inUse,
      memoryTotalBytes: totalmem(),
      unified: true,
    };
  } catch {
    return null;
  }
}

function kb(text: string, field: string): number | null {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
