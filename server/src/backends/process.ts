import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { BackendId } from '../config.js';
import { errors } from '../errors.js';
import type { LogBuffer, LogSource } from '../logs/buffer.js';
import { parseBackendLine, parseProgress } from '../logs/parse.js';
import { evaluatePolicy, sampleProcess, type HealthPolicy, type ProcessStats } from './monitor.js';

/**
 * Supervises one long-running backend process (requirement 5).
 *
 * What this owns, in the order the requirement lists it:
 *
 * - **Exactly one instance.** `startPromise` is set *synchronously* before any
 *   `await`, so two callers racing to start (a request and the boot sequence,
 *   say) join the same spawn instead of producing two servers fighting over
 *   one port. Checking `status` alone is not enough: `doStart()`'s first
 *   `await` leaves a window where status is still `stopped` while a spawn is
 *   already in flight.
 * - **Meaningful logs.** Every line is parsed for its own level
 *   (`parseBackendLine`) and pushed to the shared `LogBuffer` tagged with the
 *   backend id, so the UI can filter to one backend and see real severities
 *   rather than sd-api's undifferentiated debug stream.
 * - **Progress.** Lines carrying a `step/total` fragment are re-emitted as
 *   `progress` events for whoever is watching.
 * - **Recycling.** A monitor loop samples memory and restarts the process when
 *   it starts swapping — the audio.cpp problem.
 * - **Idle stop.** Backends are started on demand by the job or request that
 *   needs them, and stopped again once nothing has used them for the idle
 *   timeout. A resident model is gigabytes (audio.cpp loads every registered
 *   model up front), and on unified memory that is memory the next image or
 *   video job does not get. Requests hold a lease (`acquire()`) for as long as
 *   they run, so a ten-minute completion is never mistaken for idleness.
 */

export type ProcessStatus = 'stopped' | 'installing' | 'starting' | 'ready' | 'unhealthy' | 'failed';

const HEALTH_POLL_INTERVAL_MS = 300;
const STOP_GRACE_MS = 5000;
/** Collapses the restarts triggered by several downloads finishing together. */
const RESTART_DEBOUNCE_MS = 3000;
const MONITOR_INTERVAL_MS = 15_000;

export interface ManagedProcessOptions {
  backend: BackendId;
  /** Absolute path to the executable. */
  binaryPath: string;
  /** Full argv, already resolved from the arg spec + user overrides. */
  args: string[];
  /** Where to poll for readiness. Omit for a process with no health endpoint. */
  healthUrl?: string;
  startupTimeoutMs: number;
  /** Extra environment for the child, merged over the inherited environment. */
  env?: NodeJS.ProcessEnv;
  policy: HealthPolicy;
  /**
   * How long the process may sit unused before it is stopped; 0 keeps it
   * running. A getter rather than a value so a Preferences change applies to
   * a process that is already up.
   */
  idleTimeoutMs: () => number;
  /**
   * Where the child's pid is recorded while it runs, so a process orphaned by
   * a crashed or force-killed server can be found and reaped by the next one.
   */
  pidFile?: string;
}

export interface ProcessState {
  backend: BackendId;
  status: ProcessStatus;
  pid?: number;
  startedAt?: string;
  lastError?: string;
  restarts: number;
  /** Why the last automatic restart happened, if there was one. */
  lastRestartReason?: string;
  /** Why the process last stopped on its own (idle timeout), if it did. */
  lastStopReason?: string;
  /** Requests or jobs currently using the backend. */
  inFlight: number;
  /** When the backend last served traffic. */
  lastActivityAt?: string;
  /** When the idle timeout will stop it, if nothing uses it before then. */
  idleStopAt?: string;
  stats?: ProcessStats;
  /** Tail of recent output, for the "why won't it start" case. */
  recentOutput: string[];
}

export class ManagedProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private _status: ProcessStatus = 'stopped';
  private lastError: string | undefined;
  private startedAt: number | undefined;
  private outputTail: string[] = [];
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = Date.now();
  private lastStats: ProcessStats | undefined;
  private restarts = 0;
  private lastRestartReason: string | undefined;
  private lastStopReason: string | undefined;
  private inFlight = 0;
  private options: ManagedProcessOptions;

  constructor(
    options: ManagedProcessOptions,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {
    super();
    this.options = options;
    this.setMaxListeners(0);
  }

  get backend(): BackendId {
    return this.options.backend;
  }

  get status(): ProcessStatus {
    return this._status;
  }

  isReady(): boolean {
    return this._status === 'ready';
  }

  private currentStatus(): ProcessStatus {
    return this._status;
  }

  /**
   * Replace the spawn options (new binary after an install, new args after a
   * settings change). Takes effect on the next start — a running process is
   * left alone so a settings save never kills an in-flight generation.
   */
  configure(options: Partial<ManagedProcessOptions>): void {
    this.options = { ...this.options, ...options };
  }

  get config(): ManagedProcessOptions {
    return this.options;
  }

  state(): ProcessState {
    const idleTimeoutMs = this.options.idleTimeoutMs();
    const idleStopAt =
      this._status === 'ready' && this.inFlight === 0 && idleTimeoutMs > 0
        ? new Date(this.lastActivityAt + idleTimeoutMs).toISOString()
        : undefined;
    return {
      backend: this.options.backend,
      status: this._status,
      pid: this.child?.pid,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : undefined,
      lastError: this.lastError,
      restarts: this.restarts,
      lastRestartReason: this.lastRestartReason,
      lastStopReason: this.lastStopReason,
      inFlight: this.inFlight,
      lastActivityAt: this.child ? new Date(this.lastActivityAt).toISOString() : undefined,
      idleStopAt,
      stats: this.lastStats,
      recentOutput: [...this.outputTail],
    };
  }

  /** Record that the backend just served traffic, so the idle rule stays honest. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Hold the backend busy until the returned function is called. The idle
   * stop and the swap recycle both leave a process with a lease alone, so a
   * long completion or a slow speech job is never killed mid-request.
   */
  acquire(): () => void {
    this.inFlight++;
    this.markActivity();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.markActivity();
    };
  }

  async ensureRunning(signal?: AbortSignal): Promise<void> {
    if (this._status === 'ready') return;
    return this.start(signal);
  }

  /** Start, coalescing concurrent callers onto a single spawn. */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const promise = this.doStart(signal);
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    const { backend, binaryPath, args } = this.options;

    this._status = 'starting';
    this.lastError = undefined;
    this.lastStopReason = undefined;
    this.outputTail = [];
    this.stopping = false;

    // A backend left running by a previous server process (tsx watch reload,
    // crash, SIGKILL) still holds the port and its models. Spawning next to it
    // used to fail to bind while the health check passed against the orphan —
    // "ready", then "exited unexpectedly", with the memory never freed.
    try {
      await reapOrphan(
        { backend, binaryPath, healthUrl: this.options.healthUrl, pidFile: this.options.pidFile },
        this.log,
        this.logs,
      );
    } catch (err) {
      this._status = 'failed';
      this.lastError = (err as Error).message;
      throw errors.backendStartupFailed(backend, this.lastError);
    }

    this.log.info({ backend, bin: binaryPath, args }, 'spawning backend');
    this.logs.push({
      level: 'info',
      source: backend as LogSource,
      msg: `starting: ${binaryPath} ${args.join(' ')}`,
    });

    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...loaderEnv(binaryPath), ...this.options.env },
    });
    this.child = child;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();

    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line, 'stdout'));
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => this.handleLine(line, 'stderr'));
    }

    if (this.options.pidFile && child.pid) {
      const { pidFile } = this.options;
      const pid = child.pid;
      void mkdir(dirname(pidFile), { recursive: true })
        .then(() => writeFile(pidFile, String(pid)))
        .catch((err) => this.log.warn({ backend, err: (err as Error).message }, 'could not write pid file'));
    }

    child.on('exit', (code, sig) => {
      if (this.options.pidFile && child.pid) void removePidFile(this.options.pidFile, child.pid);
      this.handleExit(code, sig);
    });
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      this._status = 'failed';
      this.lastError =
        e.code === 'ENOENT'
          ? `${backend} binary not found: ${binaryPath}`
          : `Failed to start ${backend}: ${e.message}`;
      this.log.error({ backend, err: this.lastError }, 'backend spawn error');
    });

    if (!this.options.healthUrl) {
      // Nothing to poll: treat a process that is still alive a moment later as
      // up. Used by backends with no health endpoint of their own.
      await delay(200);
      if (this.currentStatus() === 'failed') {
        throw errors.backendStartupFailed(backend, this.lastError ?? 'spawn failed');
      }
      this._status = 'ready';
      this.emit('ready');
      this.startMonitor();
      return;
    }

    try {
      await this.waitForHealth(this.options.startupTimeoutMs, signal);
      this._status = 'ready';
      this.log.info({ backend, pid: child.pid }, 'backend ready');
      this.logs.push({ level: 'info', source: backend as LogSource, msg: 'backend ready' });
      this.emit('ready');
      this.startMonitor();
    } catch (err) {
      // Stopped while it was still loading: that is the user (or the idle
      // stop) winning the race, not a failed start, so it must not leave a
      // "failed" badge and a timeout message behind.
      if (this.stopping) {
        this._status = 'stopped';
        throw errors.backendStartupFailed(backend, 'stopped before it became ready');
      }
      this._status = 'failed';
      this.lastError = (err as Error).message;
      child.kill('SIGKILL');
      this.child = null;
      throw errors.backendStartupFailed(backend, this.lastError);
    }
  }

  private handleLine(line: string, stream: 'stdout' | 'stderr'): void {
    if (!line) return;
    const { level, message, origin } = parseBackendLine(line, stream);

    this.outputTail.push(line);
    if (this.outputTail.length > 200) this.outputTail.shift();

    this.logs.push({
      level,
      source: this.options.backend as LogSource,
      msg: message,
      fields: origin ? { origin } : undefined,
    });
    // Mirrored into pino at its own level so stdout (container logs) shows the
    // same severities the UI does.
    this.log[level === 'fatal' ? 'error' : level]({ backend: this.options.backend }, message);

    const progress = parseProgress(line);
    if (progress) this.emit('progress', progress);
    this.emit('line', { line, level, message });
  }

  private async waitForHealth(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error('Startup aborted');
      // stop() during startup: without this the loop polled a dead port until
      // the startup timeout, then flipped a deliberately stopped backend to
      // "failed".
      if (this.stopping) throw new Error('Stopped during startup');
      // Read through an accessor: the spawn-error handler flips `_status`
      // asynchronously, which the compiler cannot see from the assignment in
      // `doStart()` and would otherwise narrow away to a constant.
      if (this.currentStatus() === 'failed') {
        throw new Error(
          `${this.options.backend} exited before becoming healthy${this.lastError ? `: ${this.lastError}` : ''}` +
            this.tailHint(),
        );
      }
      try {
        const res = await fetch(this.options.healthUrl!, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // Not up yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${this.options.backend} health` + this.tailHint(),
        );
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
  }

  private tailHint(): string {
    return this.outputTail.length ? ` (${this.outputTail.slice(-5).join(' | ')})` : '';
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.child = null;
    this.stopMonitor();
    // A dead process holds no memory; the last sample would say otherwise.
    this.lastStats = undefined;

    if (this.stopping) {
      this._status = 'stopped';
      this.log.info({ backend: this.options.backend, code, signal }, 'backend stopped');
      return;
    }

    this._status = 'failed';
    this.lastError = `${this.options.backend} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    this.log.warn(
      { backend: this.options.backend, code, signal, tail: this.outputTail.slice(-10) },
      'backend exited unexpectedly',
    );
    this.logs.push({
      level: 'error',
      source: this.options.backend as LogSource,
      msg: this.lastError,
      fields: { tail: this.outputTail.slice(-5) },
    });
    this.emit('exit', { code, signal });
  }

  /** Stop (SIGTERM, then SIGKILL after a grace period). No-op if not running. */
  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.stopMonitor();
    this.lastStopReason = undefined;

    const child = this.child;
    if (!child) {
      this._status = 'stopped';
      return;
    }

    this.stopping = true;
    await new Promise<void>((resolvePromise) => {
      const onExit = () => {
        clearTimeout(killTimer);
        resolvePromise();
      };
      child.once('exit', onExit);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    });
    this._status = 'stopped';
  }

  async restart(reason?: string, signal?: AbortSignal): Promise<void> {
    this.clearRestartTimer();
    if (reason) {
      this.restarts++;
      this.lastRestartReason = reason;
      this.log.warn({ backend: this.options.backend, reason }, 'restarting backend');
      this.logs.push({
        level: 'warn',
        source: this.options.backend as LogSource,
        msg: `restarting: ${reason}`,
      });
    }
    await this.stop();
    await this.start(signal);
  }

  /**
   * Debounced restart, for "the world changed underneath this process" —
   * a model finished downloading, a setting was saved. Several triggers within
   * the window collapse into one restart. Non-throwing: this runs off the
   * request path, so a failure is logged rather than surfaced.
   */
  scheduleRestart(reason: string, delayMs = RESTART_DEBOUNCE_MS): void {
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Only restart something that was actually up: a backend deliberately
      // left stopped should not be started by a download finishing.
      if (this._status === 'stopped') return;
      this.restart(reason).catch((err) => {
        this.log.warn(
          { backend: this.options.backend, err: (err as Error).message },
          'scheduled restart failed',
        );
      });
    }, delayMs);
    this.restartTimer.unref();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // --- Memory / idle monitoring ---------------------------------------------

  private startMonitor(): void {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      void this.sampleAndEnforce();
    }, MONITOR_INTERVAL_MS);
    this.monitorTimer.unref();
  }

  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private async sampleAndEnforce(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid || this._status !== 'ready') return;

    const stats = await sampleProcess(pid);
    if (stats) {
      this.lastStats = stats;
      this.emit('stats', stats);
    }
    // Re-checked after the await: a request may have arrived, or the process
    // may have been stopped, while the sample was being taken.
    if (this._status !== 'ready' || this.inFlight > 0) return;

    const idleForMs = Date.now() - this.lastActivityAt;
    const idleTimeoutMs = this.options.idleTimeoutMs();
    if (idleTimeoutMs > 0 && idleForMs >= idleTimeoutMs) {
      const reason = `idle for ${formatDuration(idleForMs)}`;
      this.log.info({ backend: this.options.backend, reason }, 'stopping idle backend');
      this.logs.push({
        level: 'info',
        source: this.options.backend as LogSource,
        msg: `stopping: ${reason} (starts again on the next job)`,
      });
      await this.stop().catch((err) => {
        this.log.warn({ backend: this.options.backend, err: (err as Error).message }, 'idle stop failed');
      });
      this.lastStopReason = reason;
      return;
    }

    if (!stats) return;
    const verdict = evaluatePolicy(stats, this.options.policy);
    if (!verdict.restart) return;

    await this.restart(verdict.reason).catch((err) => {
      this.log.warn(
        { backend: this.options.backend, err: (err as Error).message },
        'health-policy restart failed',
      );
    });
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const execFileAsync = promisify(execFile);

export interface OrphanTarget {
  backend: BackendId;
  binaryPath: string;
  healthUrl?: string;
  pidFile?: string;
}

/**
 * Stop a backend left behind by a previous server process, if there is one.
 *
 * Two ways to find it: the pid file this class writes on spawn, and — for
 * orphans from before pid files, or a pid file lost with a wiped cache — the
 * process listening on the backend's port. Either way it is only killed if
 * its command line names the same executable, so an unrelated service that
 * happens to own the port is reported, never killed.
 */
export async function reapOrphan(
  target: OrphanTarget,
  log: FastifyBaseLogger,
  logs: LogBuffer,
): Promise<void> {
  const binary = basename(target.binaryPath);
  const pids = new Set<number>();

  if (target.pidFile) {
    const pid = Number((await readFile(target.pidFile, 'utf8').catch(() => '')).trim());
    if (pid > 0 && isAlive(pid) && (await commandOf(pid))?.includes(binary)) pids.add(pid);
  }

  const port = target.healthUrl ? Number(new URL(target.healthUrl).port) : 0;
  if (port && (await portAnswers(target.healthUrl!))) {
    const listeners = await listeningPids(port);
    for (const pid of listeners) {
      if ((await commandOf(pid))?.includes(binary)) pids.add(pid);
    }
    if (pids.size === 0) {
      throw new Error(
        `port ${port} is already in use by another process` +
          (listeners.length ? ` (pid ${listeners.join(', ')})` : '') +
          ` — stop it, or change ${target.backend}'s port`,
      );
    }
  }

  for (const pid of pids) {
    const msg = `stopping ${target.backend} left running by a previous server process (pid ${pid})`;
    log.warn({ backend: target.backend, pid }, 'reaping orphaned backend');
    logs.push({ level: 'warn', source: target.backend as LogSource, msg });
    await killAndWait(pid);
  }
  // Also clears a pid file whose process is already gone, so it is not
  // re-checked (against a possibly reused pid) on every start.
  if (target.pidFile) await unlink(target.pidFile).catch(() => {});
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function commandOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function portAnswers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true; // any HTTP answer at all means something owns the port
  } catch {
    return false;
  }
}

/** Pids listening on a TCP port. Empty when `lsof` is unavailable. */
async function listeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      timeout: 5000,
    });
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

async function killAndWait(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await delay(200);
}

async function removePidFile(pidFile: string, pid: number): Promise<void> {
  const recorded = (await readFile(pidFile, 'utf8').catch(() => '')).trim();
  if (recorded === String(pid)) await unlink(pidFile).catch(() => {});
}

/**
 * Child environment that lets the loader find the binary's sibling shared
 * libraries. Prebuilt releases ship `libstable-diffusion.so` / `libllama.so`
 * next to the executable, but with a RUNPATH pointing at the build machine, so
 * without this the process dies at startup with an unresolved symbol on any
 * host but the one it was compiled on.
 */
export function loaderEnv(binaryPath: string): NodeJS.ProcessEnv {
  if (!binaryPath.includes('/') && !binaryPath.includes('\\')) return { ...process.env };

  const binDir = dirname(resolve(binaryPath));
  const env = { ...process.env };
  const prepend = (key: string) => {
    env[key] = env[key] ? `${binDir}${delimiter}${env[key]}` : binDir;
  };

  if (process.platform === 'darwin') {
    prepend('DYLD_LIBRARY_PATH');
    prepend('DYLD_FALLBACK_LIBRARY_PATH');
  } else if (process.platform === 'win32') {
    prepend('PATH');
  } else {
    prepend('LD_LIBRARY_PATH');
  }
  return env;
}
