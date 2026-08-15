import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { BACKENDS, type BackendId, type Config } from '../config.js';
import { errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { SettingsStore } from '../db/settings.js';
import { backendBinDir, type Paths } from '../paths.js';
import { isExecutableAvailable } from '../util/files.js';
import {
  ARG_SPECS,
  buildArgv,
  effectiveArgs,
  readOverrides,
  writeOverrides,
  type BackendOverrides,
  type EffectiveArg,
} from './args.js';
import { BinaryInstaller, type InstalledBinary } from './installer.js';
import { ManagedProcess, type ProcessState } from './process.js';
import type { HealthPolicy } from './monitor.js';
import { PythonInstaller } from './python.js';

/**
 * The single owner of every backend's lifecycle (requirement 5: "the process
 * manager should handle the lifecycle of all the supporting applications (sd,
 * llamacpp, audiocpp, python backends)").
 *
 * sd-api had three near-identical managers — `SdWrapper`, `LlamaServerManager`
 * and `AudioServerManager`, the last two "copied almost line-for-line" by its
 * own architecture doc. Every fix to the startup race or the stop sequence had
 * to be made three times, and the audio one drifted anyway. Here the *shared*
 * behaviour (install, spawn, health, logs, recycle) lives in `ManagedProcess`
 * and this class, and the *differences* are data: an arg spec, a health path,
 * and an optional `prepare` hook for anything a backend must do before it can
 * start.
 *
 * `sdcpp` is the odd one out and stays outside the process table: it is a
 * one-shot CLI spawned per generation, not a server, so this class only
 * resolves its binary and arguments and lets the image service own the spawn.
 */

/** Backends supervised as long-running processes. */
const SERVER_BACKENDS: BackendId[] = ['llamacpp', 'audiocpp', 'python'];

export interface PrepareResult {
  /**
   * Skip the spawn entirely and leave the backend stopped, without treating it
   * as a failure. audio.cpp needs this: it refuses to start with an empty
   * model registry, and "no audio models installed yet" is an ordinary state
   * on a fresh deployment, not a startup error.
   */
  skip?: boolean;
  /** Reason to log when skipping. */
  reason?: string;
  /** Values for the spec's `locked` arguments, computed at spawn time. */
  managed?: Record<string, string | number | boolean | null>;
}

export type PrepareHook = () => Promise<PrepareResult>;

export interface BackendStatus extends ProcessState {
  label: string;
  kind: 'server' | 'cli';
  installed: boolean;
  binaryPath?: string;
  releaseTag?: string;
  releaseRepo: string;
  /** The exact argv the backend will spawn with. */
  args: EffectiveArg[];
  extraArgs: string[];
  argv: string[];
}

export class BackendManager {
  private readonly processes = new Map<BackendId, ManagedProcess>();
  private readonly installers = new Map<BackendId, BinaryInstaller>();
  private readonly prepares = new Map<BackendId, PrepareHook>();
  private readonly binaries = new Map<BackendId, InstalledBinary>();
  private readonly installPromises = new Map<BackendId, Promise<InstalledBinary | null>>();
  private readonly pythonInstaller: PythonInstaller;

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly settings: SettingsStore,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {
    for (const backend of BACKENDS) {
      this.installers.set(
        backend,
        new BinaryInstaller(
          {
            backend,
            repo: config.releaseRepos[backend],
            installDir: backendBinDir(paths, backend),
            accel: config.accel,
          },
          log,
        ),
      );
    }
    this.pythonInstaller = new PythonInstaller(backendBinDir(paths, 'python'), log);
  }

  /** Register a hook run before each spawn of `backend`. */
  setPrepare(backend: BackendId, hook: PrepareHook): void {
    this.prepares.set(backend, hook);
  }

  /**
   * Health policy for the recycle monitor. Thresholds are derived from total
   * system memory rather than fixed: "500MB while idle" is negligible on a
   * 200GB inference host and most of the budget on a small one.
   */
  private policy(totalKb: number): HealthPolicy {
    return {
      // Any sustained swapping is already the pathological state; the small
      // allowance absorbs the few MB a process may have parked at startup
      // without ever touching again.
      swapLimitKb: 256 * 1024,
      idleAfterMs: 15 * 60 * 1000,
      idleRssLimitKb: Math.max(2 * 1024 * 1024, Math.round(totalKb * 0.15)),
    };
  }

  /** Resolve a usable binary path, installing one if allowed. */
  async ensureInstalled(backend: BackendId, signal?: AbortSignal): Promise<InstalledBinary | null> {
    const cached = this.binaries.get(backend);
    if (cached) return cached;

    // Coalesce: boot and a first request can both ask at once, and two
    // simultaneous installs would race on the same staging directory.
    const inFlight = this.installPromises.get(backend);
    if (inFlight) return inFlight;

    const promise = this.doEnsureInstalled(backend, signal);
    this.installPromises.set(backend, promise);
    try {
      return await promise;
    } finally {
      this.installPromises.delete(backend);
    }
  }

  private async doEnsureInstalled(
    backend: BackendId,
    signal?: AbortSignal,
  ): Promise<InstalledBinary | null> {
    if (backend === 'python') return this.ensurePythonInstalled(signal);

    const installer = this.installers.get(backend)!;

    const previous = await installer.installed();
    if (previous) {
      this.binaries.set(backend, previous);
      this.log.info({ backend, binaryPath: previous.binaryPath, tag: previous.tag }, 'backend already installed');
      return previous;
    }

    // A binary already on PATH wins over downloading one — that is how a
    // developer points the app at a locally built backend, and how an image
    // that bakes the binaries in avoids a pointless download on every boot.
    const specName = DEFAULT_COMMANDS[backend];
    if (specName && (await isExecutableAvailable(specName))) {
      const found: InstalledBinary = {
        backend,
        binaryPath: specName,
        tag: 'system',
        asset: specName,
        installedAt: new Date().toISOString(),
      };
      this.binaries.set(backend, found);
      this.log.info({ backend, binary: specName }, 'using backend binary from PATH');
      return found;
    }

    if (!this.config.autoInstallBackends) {
      this.log.warn({ backend }, 'backend not installed and AUTO_INSTALL_BACKENDS is off');
      return null;
    }

    const installed = await installer.install(signal);
    this.binaries.set(backend, installed);
    return installed;
  }

  private async ensurePythonInstalled(signal?: AbortSignal): Promise<InstalledBinary | null> {
    const existing = await this.pythonInstaller.installed();
    if (existing) {
      const record: InstalledBinary = {
        backend: 'python',
        binaryPath: existing.pythonPath,
        tag: existing.version,
        asset: existing.version,
        installedAt: existing.installedAt,
      };
      this.binaries.set('python', record);
      return record;
    }
    // Never installed implicitly: a standalone runtime plus a package tree is
    // gigabytes and minutes, and nothing generates against it yet. It is
    // installed when asked for, via POST /v1/backends/python/install.
    if (!signal) return null;

    const runtime = await this.pythonInstaller.installRuntime(signal);
    const record: InstalledBinary = {
      backend: 'python',
      binaryPath: runtime.pythonPath,
      tag: runtime.version,
      asset: runtime.version,
      installedAt: runtime.installedAt,
    };
    this.binaries.set('python', record);
    return record;
  }

  /** Force a reinstall from the latest release, restarting the backend after. */
  async reinstall(backend: BackendId, signal?: AbortSignal): Promise<InstalledBinary> {
    if (backend === 'python') {
      const runtime = await this.pythonInstaller.installRuntime(signal ?? AbortSignal.timeout(1_800_000));
      const record: InstalledBinary = {
        backend: 'python',
        binaryPath: runtime.pythonPath,
        tag: runtime.version,
        asset: runtime.version,
        installedAt: runtime.installedAt,
      };
      this.binaries.set('python', record);
      return record;
    }

    const installed = await this.installers.get(backend)!.install(signal);
    this.binaries.set(backend, installed);

    const proc = this.processes.get(backend);
    if (proc) {
      proc.configure({ binaryPath: installed.binaryPath });
      if (proc.status === 'ready') await proc.restart('backend reinstalled', signal);
    }
    return installed;
  }

  /** The resolved binary path, or null if the backend is not installed. */
  binaryPath(backend: BackendId): string | null {
    return this.binaries.get(backend)?.binaryPath ?? null;
  }

  /** Argv for a backend, as currently configured. */
  argv(backend: BackendId, managed: Record<string, string | number | boolean | null> = {}): string[] {
    return buildArgv(ARG_SPECS[backend], readOverrides(this.settings, backend), managed);
  }

  /** Values the process manager computes for a backend's locked arguments. */
  private managedValues(backend: BackendId): Record<string, string | number | boolean | null> {
    switch (backend) {
      case 'llamacpp':
        return {
          models_dir: join(this.paths.modelsDir, 'llm'),
          host: '127.0.0.1',
          port: this.config.llamacppPort,
        };
      case 'audiocpp':
        return {
          config: join(this.paths.cacheDir, 'audio-server-config.generated.json'),
          host: '127.0.0.1',
          port: this.config.audiocppPort,
        };
      case 'python':
        return { listen: '127.0.0.1', port: this.config.pythonPort };
      default:
        return {};
    }
  }

  private healthUrl(backend: BackendId): string | undefined {
    switch (backend) {
      case 'llamacpp':
        return `http://127.0.0.1:${this.config.llamacppPort}/health`;
      case 'audiocpp':
        return `http://127.0.0.1:${this.config.audiocppPort}/health`;
      case 'python':
        return `http://127.0.0.1:${this.config.pythonPort}/system_stats`;
      default:
        return undefined;
    }
  }

  /** Base URL of a backend's loopback HTTP server. */
  baseUrl(backend: BackendId): string {
    switch (backend) {
      case 'llamacpp':
        return `http://127.0.0.1:${this.config.llamacppPort}`;
      case 'audiocpp':
        return `http://127.0.0.1:${this.config.audiocppPort}`;
      case 'python':
        return `http://127.0.0.1:${this.config.pythonPort}`;
      default:
        throw errors.unsupported(`${backend} is not an HTTP backend`);
    }
  }

  get(backend: BackendId): ManagedProcess | undefined {
    return this.processes.get(backend);
  }

  /**
   * Install if needed, then start — the single entry point every caller uses.
   * Idempotent, and safe to call from several places at once.
   */
  async ensureRunning(backend: BackendId, signal?: AbortSignal): Promise<ManagedProcess | null> {
    if (!SERVER_BACKENDS.includes(backend)) {
      throw errors.unsupported(`${backend} is not a supervised server backend`);
    }

    const installed = await this.ensureInstalled(backend, signal);
    if (!installed) {
      throw errors.backendBinaryNotFound(backend, DEFAULT_COMMANDS[backend] ?? backend);
    }

    const prepare = this.prepares.get(backend);
    const prepared = prepare ? await prepare() : {};
    if (prepared.skip) {
      this.log.info({ backend, reason: prepared.reason }, 'backend start skipped');
      return null;
    }

    const managed = { ...this.managedValues(backend), ...prepared.managed };
    const overrides = readOverrides(this.settings, backend);
    const args = buildArgv(ARG_SPECS[backend], overrides, managed);

    let proc = this.processes.get(backend);
    if (!proc) {
      const { totalMemoryKb } = await import('./monitor.js');
      proc = new ManagedProcess(
        {
          backend,
          binaryPath: installed.binaryPath,
          args,
          healthUrl: this.healthUrl(backend),
          startupTimeoutMs: this.config.backendStartupTimeoutMs,
          policy: this.policy(await totalMemoryKb()),
        },
        this.log,
        this.logs,
      );
      this.processes.set(backend, proc);
    } else {
      // Pick up a settings change or a reinstall that happened while stopped.
      proc.configure({ binaryPath: installed.binaryPath, args });
    }

    await proc.ensureRunning(signal);
    return proc;
  }

  /**
   * Restart a backend because the world changed under it — a model finished
   * downloading, settings were saved. Debounced and non-throwing.
   */
  scheduleRestart(backend: BackendId, reason: string): void {
    const proc = this.processes.get(backend);
    if (!proc) return;

    // Re-resolve argv: a download can change a locked value (audio.cpp's
    // generated registry), and restarting with the old one would defeat the
    // point of the restart.
    void (async () => {
      const prepare = this.prepares.get(backend);
      const prepared = prepare ? await prepare().catch(() => ({}) as PrepareResult) : {};
      const managed = { ...this.managedValues(backend), ...prepared.managed };
      proc.configure({ args: buildArgv(ARG_SPECS[backend], readOverrides(this.settings, backend), managed) });
      proc.scheduleRestart(reason);
    })();
  }

  /** Update a backend's CLI arguments and restart it if it is running. */
  async updateArgs(backend: BackendId, overrides: BackendOverrides): Promise<BackendStatus> {
    writeOverrides(this.settings, backend, overrides);
    const proc = this.processes.get(backend);
    if (proc) {
      const prepare = this.prepares.get(backend);
      const prepared = prepare ? await prepare().catch(() => ({}) as PrepareResult) : {};
      const managed = { ...this.managedValues(backend), ...prepared.managed };
      proc.configure({ args: buildArgv(ARG_SPECS[backend], overrides, managed) });
      if (proc.status === 'ready') await proc.restart('arguments changed');
    }
    return this.status(backend);
  }

  status(backend: BackendId): BackendStatus {
    const spec = ARG_SPECS[backend];
    const overrides = readOverrides(this.settings, backend);
    const args = effectiveArgs(spec, overrides, this.managedValues(backend));
    const installed = this.binaries.get(backend);
    const proc = this.processes.get(backend);

    const state: ProcessState = proc?.state() ?? {
      backend,
      status: 'stopped',
      restarts: 0,
      recentOutput: [],
    };

    return {
      ...state,
      label: spec.label,
      kind: spec.kind,
      installed: Boolean(installed),
      binaryPath: installed?.binaryPath,
      releaseTag: installed?.tag,
      releaseRepo: this.config.releaseRepos[backend],
      args,
      extraArgs: overrides.extraArgs,
      argv: buildArgv(spec, overrides, this.managedValues(backend)),
    };
  }

  statusAll(): BackendStatus[] {
    return BACKENDS.map((backend) => this.status(backend));
  }

  /** Discover what is already installed, without starting anything. */
  async refreshInstalled(): Promise<void> {
    await Promise.all(
      BACKENDS.map(async (backend) => {
        try {
          if (backend === 'python') {
            const runtime = await this.pythonInstaller.installed();
            if (runtime) {
              this.binaries.set('python', {
                backend: 'python',
                binaryPath: runtime.pythonPath,
                tag: runtime.version,
                asset: runtime.version,
                installedAt: runtime.installedAt,
              });
            }
            return;
          }
          const installed = await this.installers.get(backend)!.installed();
          if (installed) this.binaries.set(backend, installed);
        } catch (err) {
          this.log.warn({ backend, err: (err as Error).message }, 'failed to inspect backend install');
        }
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.values()].map((proc) => proc.stop().catch(() => {})));
  }

  get python(): PythonInstaller {
    return this.pythonInstaller;
  }
}

/** Command names looked for on PATH before falling back to a download. */
const DEFAULT_COMMANDS: Partial<Record<BackendId, string>> = {
  sdcpp: 'sd-cli',
  llamacpp: 'llama-server',
  audiocpp: 'audiocpp_server',
};
