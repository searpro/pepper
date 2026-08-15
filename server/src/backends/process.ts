import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { delimiter, dirname, resolve } from 'node:path';
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
 *   it starts swapping or sits idle holding memory — the audio.cpp problem.
 */

export type ProcessStatus = 'stopped' | 'installing' | 'starting' | 'ready' | 'unhealthy' | 'failed';

const HEALTH_POLL_INTERVAL_MS = 300;
const STOP_GRACE_MS = 5000;
/** Collapses the restarts triggered by several downloads finishing together. */
const RESTART_DEBOUNCE_MS = 3000;
const MONITOR_INTERVAL_MS = 30_000;

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
    return {
      backend: this.options.backend,
      status: this._status,
      pid: this.child?.pid,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : undefined,
      lastError: this.lastError,
      restarts: this.restarts,
      lastRestartReason: this.lastRestartReason,
      stats: this.lastStats,
      recentOutput: [...this.outputTail],
    };
  }

  /** Record that the backend just served traffic, so the idle rule stays honest. */
  markActivity(): void {
    this.lastActivityAt = Date.now();
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
    this.outputTail = [];
    this.stopping = false;

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

    child.on('exit', (code, sig) => this.handleExit(code, sig));
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
    if (!stats) return;
    this.lastStats = stats;
    this.emit('stats', stats);

    const verdict = evaluatePolicy(stats, Date.now() - this.lastActivityAt, this.options.policy);
    if (!verdict.restart) return;

    // Restarting mid-request would fail whatever is in flight, and the whole
    // point of the idle rule is that nothing is. `markActivity()` is called by
    // the proxy on every request, so a recent timestamp means "busy".
    if (Date.now() - this.lastActivityAt < 5000) return;

    await this.restart(verdict.reason).catch((err) => {
      this.log.warn(
        { backend: this.options.backend, err: (err as Error).message },
        'health-policy restart failed',
      );
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
