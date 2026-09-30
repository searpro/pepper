import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import { defineSetting, type SettingsStore } from '../db/settings.js';
import { isExecutableAvailable } from '../util/files.js';
import {
  buildArgv,
  effectiveArgs,
  readOverrides,
  writeOverrides,
  type BackendArgSpec,
  type BackendOverrides,
  type EffectiveArg,
} from './args.js';
import type { InstalledBinary } from './installer.js';
import { ManagedProcess, reapOrphan, type ProcessState } from './process.js';
import type { HealthPolicy } from './monitor.js';

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
 * and this class, and the *differences* are data: a `BackendDefinition` per
 * backend (arg spec, install strategy, port, health path) and an optional
 * `prepare` hook for anything a backend must do before it can start.
 *
 * The definitions come from the product using the manager — Pepper supervises
 * sd-cli, llama.cpp, audio.cpp, vLLM and a Python server; Pepper Pro
 * supervises llama.cpp and ComfyUI — so nothing here names a backend.
 *
 * A `cli` backend (sd-cli) stays outside the process table: it is a one-shot
 * CLI spawned per generation, not a server, so this class only resolves its
 * binary and arguments and lets the service that runs it own the spawn.
 */

type ArgValue = string | number | boolean | null;

/** How a backend's executable gets onto the machine. */
export interface BackendInstaller {
  /** What is installed now, without installing anything. */
  installed(): Promise<InstalledBinary | null>;
  /**
   * Install it. Absent for a backend that only ever comes from the image or
   * from PATH (vLLM), for which "reinstall" re-checks what is there.
   */
  install?(signal?: AbortSignal): Promise<InstalledBinary>;
  /**
   * Whether a first use may install it unasked. False for a multi-gigabyte
   * runtime that is installed only when someone asks (the Python backend):
   * then `ensureInstalled` installs only when handed an abort signal, which
   * is how the explicit install route calls it.
   */
  implicit?: boolean;
}

export interface BackendDefinition {
  /** Stable id: the settings key, the log source, the route segment. */
  id: string;
  argSpec: BackendArgSpec;
  /** Executable looked for on PATH before anything is downloaded. */
  command?: string;
  /** Where releases come from, shown in the status for the Preferences screen. */
  releaseRepo?: string;
  installer?: BackendInstaller;
  /** Loopback HTTP server details; absent for a `cli` backend. */
  server?: {
    port: number;
    /** Readiness path, e.g. `/health`. */
    healthPath: string;
  };
  /** Values for the spec's locked arguments (host, port, model directory…). */
  managed?: () => Record<string, ArgValue>;
  /** Overrides the manager's startup timeout for a backend that boots slowly (ComfyUI imports torch and every node pack). */
  startupTimeoutMs?: number;
}

export interface BackendManagerOptions {
  /** Install missing binaries on first use. */
  autoInstall: boolean;
  startupTimeoutMs: number;
  /** Default idle timeout; Preferences can override it. */
  idleTimeoutMs: number;
  /** Where pid files go, so a restart can reap what the last process left running. */
  runDir: string;
}

/**
 * The idle timeout chosen in Preferences, in milliseconds. `null` means "use
 * BACKEND_IDLE_TIMEOUT"; 0 keeps backends running until stopped by hand.
 */
const idleTimeoutKey = defineSetting<number | null>(
  'backends.idleTimeoutMs',
  z.number().int().min(0).nullable(),
  null,
);

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
  managed?: Record<string, ArgValue>;
  /**
   * Argv entries inserted before the spec-rendered flags — e.g. a Python
   * server's entrypoint script, which has to be the interpreter's first
   * positional argument rather than a `--flag value` pair.
   */
  argvPrefix?: string[];
  /**
   * Overrides the backend's default health-check path for this spawn, for a
   * prepare hook that knows better than the backend-wide default.
   */
  healthPath?: string;
  /** Extra environment for the child. */
  env?: NodeJS.ProcessEnv;
}

export type PrepareHook = () => Promise<PrepareResult>;

export interface BackendStatus extends ProcessState {
  label: string;
  kind: 'server' | 'cli';
  installed: boolean;
  binaryPath?: string;
  releaseTag?: string;
  releaseRepo?: string;
  /** The exact argv the backend will spawn with. */
  args: EffectiveArg[];
  extraArgs: string[];
  argv: string[];
  /** Why the last start was skipped (e.g. no audio models), if it was. */
  note?: string;
  /** Effective idle timeout; 0 means the backend is never stopped for idleness. */
  idleTimeoutMs: number;
}

export class BackendManager {
  private readonly definitions = new Map<string, BackendDefinition>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly prepares = new Map<string, PrepareHook>();
  private readonly binaries = new Map<string, InstalledBinary>();
  private readonly installPromises = new Map<string, Promise<InstalledBinary | null>>();
  private readonly skipReasons = new Map<string, string>();

  constructor(
    definitions: BackendDefinition[],
    private readonly options: BackendManagerOptions,
    private readonly settings: SettingsStore,
    protected readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {
    for (const definition of definitions) this.definitions.set(definition.id, definition);
  }

  /** Every backend id this manager knows, in definition order. */
  ids(): string[] {
    return [...this.definitions.keys()];
  }

  has(backend: string): boolean {
    return this.definitions.has(backend);
  }

  private definition(backend: string): BackendDefinition {
    const definition = this.definitions.get(backend);
    if (!definition) throw errors.backendNotFound(backend);
    return definition;
  }

  /** Register a hook run before each spawn of `backend`. */
  setPrepare(backend: string, hook: PrepareHook): void {
    this.prepares.set(backend, hook);
  }

  /** Health policy for the recycle monitor. */
  private policy(): HealthPolicy {
    return {
      // Any sustained swapping is already the pathological state; the small
      // allowance absorbs the few MB a process may have parked at startup
      // without ever touching again.
      swapLimitKb: 256 * 1024,
    };
  }

  private pidFile(backend: string): string {
    return join(this.options.runDir, `${backend}.pid`);
  }

  private serverIds(): string[] {
    return this.ids().filter((id) => this.definitions.get(id)!.argSpec.kind === 'server');
  }

  /**
   * Stop backends a previous server process left running. Called at boot:
   * with backends now started on demand, nothing else would touch an orphan
   * until a job needed that backend, and until then it holds its models.
   */
  async reapOrphans(): Promise<void> {
    await Promise.all(
      this.serverIds().map(async (backend) => {
        const binaryPath = this.binaries.get(backend)?.binaryPath ?? this.definitions.get(backend)!.command;
        if (!binaryPath || this.processes.get(backend)?.status === 'ready') return;
        try {
          await reapOrphan(
            { backend, binaryPath, healthUrl: this.healthUrl(backend), pidFile: this.pidFile(backend) },
            this.log,
            this.logs,
          );
        } catch (err) {
          this.log.warn({ backend, err: (err as Error).message }, 'backend port is taken');
        }
      }),
    );
  }

  /** How long a backend may sit unused before it is stopped (0 = never). */
  idleTimeoutMs(): number {
    return this.settings.get(idleTimeoutKey) ?? this.options.idleTimeoutMs;
  }

  /** Persist the Preferences idle timeout; `null` reverts to the env default. */
  setIdleTimeout(ms: number | null): number {
    if (ms === null) this.settings.reset(idleTimeoutKey);
    else this.settings.set(idleTimeoutKey, ms);
    return this.idleTimeoutMs();
  }

  /** Resolve a usable binary path, installing one if allowed. */
  async ensureInstalled(backend: string, signal?: AbortSignal): Promise<InstalledBinary | null> {
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

  private async doEnsureInstalled(backend: string, signal?: AbortSignal): Promise<InstalledBinary | null> {
    const definition = this.definition(backend);
    const installer = definition.installer;

    const previous = await installer?.installed();
    if (previous) {
      this.binaries.set(backend, previous);
      this.log.info({ backend, binaryPath: previous.binaryPath, tag: previous.tag }, 'backend already installed');
      return previous;
    }

    // A binary already on PATH wins over downloading one — that is how a
    // developer points the app at a locally built backend, and how an image
    // that bakes the binaries in avoids a pointless download on every boot.
    const found = await this.fromPath(definition);
    if (found) return found;

    if (!installer?.install) {
      this.log.info({ backend }, `${backend} is not installed and cannot be installed by the app`);
      return null;
    }
    if (installer.implicit === false && !signal) return null;
    if (!this.options.autoInstall && installer.implicit !== false) {
      this.log.warn({ backend }, 'backend not installed and AUTO_INSTALL_BACKENDS is off');
      return null;
    }

    const installed = await installer.install(signal);
    this.binaries.set(backend, installed);
    return installed;
  }

  private async fromPath(definition: BackendDefinition): Promise<InstalledBinary | null> {
    if (!definition.command || !(await isExecutableAvailable(definition.command))) return null;
    const found: InstalledBinary = {
      backend: definition.id,
      binaryPath: definition.command,
      tag: 'system',
      asset: definition.command,
      installedAt: new Date().toISOString(),
    };
    this.binaries.set(definition.id, found);
    this.log.info({ backend: definition.id, binary: definition.command }, 'using backend binary from PATH');
    return found;
  }

  /** Force a reinstall from the latest release, restarting the backend after. */
  async reinstall(backend: string, signal?: AbortSignal): Promise<InstalledBinary> {
    const definition = this.definition(backend);
    const installer = definition.installer;

    let installed: InstalledBinary | null;
    if (installer?.install) {
      installed = await installer.install(signal ?? AbortSignal.timeout(1_800_000));
    } else {
      // Nothing to redownload — the backend only ever comes from the image or
      // PATH. "Reinstall" re-checks what is there.
      this.binaries.delete(backend);
      installed = (await installer?.installed()) ?? (await this.fromPath(definition));
      if (!installed) throw errors.backendBinaryNotFound(backend, definition.command ?? backend);
    }
    this.binaries.set(backend, installed);

    const proc = this.processes.get(backend);
    if (proc) {
      proc.configure({ binaryPath: installed.binaryPath });
      if (proc.status === 'ready') await proc.restart('backend reinstalled', signal);
    }
    return installed;
  }

  /** The resolved binary path, or null if the backend is not installed. */
  binaryPath(backend: string): string | null {
    return this.binaries.get(backend)?.binaryPath ?? null;
  }

  /** Argv for a backend, as currently configured. */
  argv(backend: string, managed: Record<string, ArgValue> = {}): string[] {
    return buildArgv(this.definition(backend).argSpec, readOverrides(this.settings, backend), managed);
  }

  private managedValues(backend: string): Record<string, ArgValue> {
    return this.definition(backend).managed?.() ?? {};
  }

  private healthUrl(backend: string, healthPath?: string): string | undefined {
    const server = this.definition(backend).server;
    if (!server) return undefined;
    return `http://127.0.0.1:${server.port}${healthPath ?? server.healthPath}`;
  }

  /** Base URL of a backend's loopback HTTP server. */
  baseUrl(backend: string): string {
    const server = this.definition(backend).server;
    if (!server) throw errors.unsupported(`${backend} is not an HTTP backend`);
    return `http://127.0.0.1:${server.port}`;
  }

  get(backend: string): ManagedProcess | undefined {
    return this.processes.get(backend);
  }

  private async spawnArgs(backend: string, overrides: BackendOverrides, prepared: PrepareResult): Promise<string[]> {
    const managed = { ...this.managedValues(backend), ...prepared.managed };
    return [...(prepared.argvPrefix ?? []), ...buildArgv(this.definition(backend).argSpec, overrides, managed)];
  }

  /**
   * Install if needed, then start — the single entry point every caller uses.
   * Idempotent, and safe to call from several places at once.
   */
  async ensureRunning(backend: string, signal?: AbortSignal): Promise<ManagedProcess | null> {
    const definition = this.definition(backend);
    if (definition.argSpec.kind !== 'server') {
      throw errors.unsupported(`${backend} is not a supervised server backend`);
    }

    const installed = await this.ensureInstalled(backend, signal);
    if (!installed) {
      throw errors.backendBinaryNotFound(backend, definition.command ?? backend);
    }

    const prepare = this.prepares.get(backend);
    const prepared = prepare ? await prepare() : {};
    if (prepared.skip) {
      this.log.info({ backend, reason: prepared.reason }, 'backend start skipped');
      if (prepared.reason) this.skipReasons.set(backend, prepared.reason);
      return null;
    }
    this.skipReasons.delete(backend);

    const args = await this.spawnArgs(backend, readOverrides(this.settings, backend), prepared);

    let proc = this.processes.get(backend);
    if (!proc) {
      proc = new ManagedProcess(
        {
          backend,
          binaryPath: installed.binaryPath,
          args,
          env: prepared.env,
          healthUrl: this.healthUrl(backend, prepared.healthPath),
          startupTimeoutMs: definition.startupTimeoutMs ?? this.options.startupTimeoutMs,
          policy: this.policy(),
          idleTimeoutMs: () => this.idleTimeoutMs(),
          pidFile: this.pidFile(backend),
        },
        this.log,
        this.logs,
      );
      this.processes.set(backend, proc);
    } else {
      // Pick up a settings change or a reinstall that happened while stopped.
      proc.configure({ binaryPath: installed.binaryPath, args, env: prepared.env });
    }

    await proc.ensureRunning(signal);
    // Whoever asked is about to use it; without this an already-running
    // backend a few seconds short of its idle timeout could be stopped
    // between this returning and the caller taking its lease.
    proc.markActivity();
    return proc;
  }

  /**
   * Start a backend if needed and hold it busy until `release` is called —
   * the entry point for jobs and proxied requests. Returns null when the
   * backend has nothing to serve (see `PrepareResult.skip`).
   */
  async acquire(
    backend: string,
    signal?: AbortSignal,
  ): Promise<{ process: ManagedProcess; release: () => void } | null> {
    const process = await this.ensureRunning(backend, signal);
    if (!process) return null;
    return { process, release: process.acquire() };
  }

  /**
   * Restart a backend because the world changed under it — a model finished
   * downloading, settings were saved. Debounced and non-throwing.
   */
  scheduleRestart(backend: string, reason: string): void {
    const proc = this.processes.get(backend);
    if (!proc) return;

    // Re-resolve argv: a download can change a locked value (audio.cpp's
    // generated registry), and restarting with the old one would defeat the
    // point of the restart.
    void (async () => {
      const prepare = this.prepares.get(backend);
      const prepared = prepare ? await prepare().catch(() => ({}) as PrepareResult) : {};
      const args = await this.spawnArgs(backend, readOverrides(this.settings, backend), prepared);
      proc.configure({ args, env: prepared.env, healthUrl: this.healthUrl(backend, prepared.healthPath) });
      proc.scheduleRestart(reason);
    })();
  }

  /** Update a backend's CLI arguments and restart it if it is running. */
  async updateArgs(backend: string, overrides: BackendOverrides): Promise<BackendStatus> {
    this.definition(backend);
    writeOverrides(this.settings, backend, overrides);
    const proc = this.processes.get(backend);
    if (proc) {
      const prepare = this.prepares.get(backend);
      const prepared = prepare ? await prepare().catch(() => ({}) as PrepareResult) : {};
      const args = await this.spawnArgs(backend, overrides, prepared);
      proc.configure({ args, env: prepared.env, healthUrl: this.healthUrl(backend, prepared.healthPath) });
      if (proc.status === 'ready') await proc.restart('arguments changed');
    }
    return this.status(backend);
  }

  status(backend: string): BackendStatus {
    const definition = this.definition(backend);
    const spec = definition.argSpec;
    const overrides = readOverrides(this.settings, backend);
    const args = effectiveArgs(spec, overrides, this.managedValues(backend));
    const installed = this.binaries.get(backend);
    const proc = this.processes.get(backend);

    const state: ProcessState = proc?.state() ?? {
      backend,
      status: 'stopped',
      restarts: 0,
      inFlight: 0,
      recentOutput: [],
    };

    return {
      ...state,
      label: spec.label,
      kind: spec.kind,
      installed: Boolean(installed),
      binaryPath: installed?.binaryPath,
      releaseTag: installed?.tag,
      releaseRepo: definition.releaseRepo,
      args,
      extraArgs: overrides.extraArgs,
      argv: buildArgv(spec, overrides, this.managedValues(backend)),
      note: state.status === 'ready' ? undefined : this.skipReasons.get(backend),
      idleTimeoutMs: spec.kind === 'server' ? this.idleTimeoutMs() : 0,
    };
  }

  statusAll(): BackendStatus[] {
    return this.ids().map((backend) => this.status(backend));
  }

  /** Discover what is already installed, without starting or installing anything. */
  async refreshInstalled(): Promise<void> {
    await Promise.all(
      this.ids().map(async (backend) => {
        const definition = this.definitions.get(backend)!;
        try {
          const installed = await definition.installer?.installed();
          if (installed) this.binaries.set(backend, installed);
          else if (!definition.installer?.install) await this.fromPath(definition);
        } catch (err) {
          this.log.warn({ backend, err: (err as Error).message }, 'failed to inspect backend install');
        }
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.values()].map((proc) => proc.stop().catch(() => {})));
  }
}
