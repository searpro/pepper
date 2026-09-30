import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BackendId, Config } from '../config.js';
import type { SettingsStore } from '../core/db/settings.js';
import type { LogBuffer } from '../core/logs/buffer.js';
import { backendBinDir, type Paths } from '../paths.js';
import { ARG_SPECS } from './args.js';
import { BinaryInstaller, type InstalledBinary } from '../core/backends/installer.js';
import { BackendManager, type BackendDefinition, type BackendInstaller } from '../core/backends/manager.js';
import { PythonInstaller } from './python.js';

/**
 * Pepper's backends as data for the shared `BackendManager`: sd-cli (a CLI),
 * and llama.cpp, audio.cpp, vLLM and a Python server (supervised servers).
 */

/** Command names looked for on PATH before falling back to a download. */
const DEFAULT_COMMANDS: Partial<Record<BackendId, string>> = {
  sdcpp: 'sd-cli',
  llamacpp: 'llama-server',
  audiocpp: 'audiocpp_server',
  vllm: 'vllm',
};

/**
 * The Python backend is a runtime rather than a release archive, and it is
 * gigabytes: installed only when someone asks (POST /v1/backends/python/install),
 * never implicitly by a first use.
 */
function pythonInstaller(installer: PythonInstaller): BackendInstaller {
  const record = (runtime: { pythonPath: string; version: string; installedAt: string }): InstalledBinary => ({
    backend: 'python',
    binaryPath: runtime.pythonPath,
    tag: runtime.version,
    asset: runtime.version,
    installedAt: runtime.installedAt,
  });
  return {
    implicit: false,
    installed: async () => {
      const existing = await installer.installed();
      return existing ? record(existing) : null;
    },
    install: async (signal) => record(await installer.installRuntime(signal ?? AbortSignal.timeout(1_800_000))),
  };
}

export function pepperBackendDefinitions(
  config: Config,
  paths: Paths,
  python: PythonInstaller,
  log: FastifyBaseLogger,
): BackendDefinition[] {
  const release = (backend: BackendId): BinaryInstaller =>
    new BinaryInstaller(
      {
        backend,
        repo: config.releaseRepos[backend],
        installDir: backendBinDir(paths, backend),
        accel: config.accel,
      },
      log,
    );

  return [
    {
      id: 'sdcpp',
      argSpec: ARG_SPECS.sdcpp,
      command: DEFAULT_COMMANDS.sdcpp,
      releaseRepo: config.releaseRepos.sdcpp,
      installer: release('sdcpp'),
    },
    {
      id: 'llamacpp',
      argSpec: ARG_SPECS.llamacpp,
      command: DEFAULT_COMMANDS.llamacpp,
      releaseRepo: config.releaseRepos.llamacpp,
      installer: release('llamacpp'),
      server: { port: config.llamacppPort, healthPath: '/health' },
      managed: () => ({
        models_dir: join(paths.modelsDir, 'llm'),
        host: '127.0.0.1',
        port: config.llamacppPort,
      }),
    },
    {
      id: 'audiocpp',
      argSpec: ARG_SPECS.audiocpp,
      command: DEFAULT_COMMANDS.audiocpp,
      releaseRepo: config.releaseRepos.audiocpp,
      installer: release('audiocpp'),
      server: { port: config.audiocppPort, healthPath: '/health' },
      managed: () => ({
        config: join(paths.cacheDir, 'audio-server-config.generated.json'),
        host: '127.0.0.1',
        port: config.audiocppPort,
        // Every Accel value is a name audiocpp_server accepts verbatim
        // (it treats rocm as an alias for hip), so no mapping is needed.
        backend: config.accel,
      }),
    },
    {
      id: 'python',
      argSpec: ARG_SPECS.python,
      releaseRepo: config.releaseRepos.python,
      installer: pythonInstaller(python),
      // `/system_stats` is ComfyUI's endpoint; a package that answers
      // elsewhere says so through its prepare hook (`PrepareResult.healthPath`).
      server: { port: config.pythonPort, healthPath: '/system_stats' },
      managed: () => ({ listen: '127.0.0.1', port: config.pythonPort }),
    },
    {
      // vLLM has no release-archive install path: it is baked into the
      // production image (see Dockerfile.vllm) rather than downloaded, so
      // `vllm` on PATH is either there from the image or not there at all. A
      // developer without it gets a clear "not found" rather than a pip
      // install against whatever CUDA/PyTorch happens to be on their machine.
      id: 'vllm',
      argSpec: ARG_SPECS.vllm,
      command: DEFAULT_COMMANDS.vllm,
      server: { port: config.vllmPort, healthPath: '/health' },
      managed: () => ({ host: '127.0.0.1', port: config.vllmPort }),
    },
  ];
}

/** The shared manager plus the Python installer Pepper's runners use directly. */
export class PepperBackendManager extends BackendManager {
  readonly python: PythonInstaller;

  constructor(config: Config, paths: Paths, settings: SettingsStore, log: FastifyBaseLogger, logs: LogBuffer) {
    const python = new PythonInstaller(config.pythonDir ?? backendBinDir(paths, 'python'), log);
    super(
      pepperBackendDefinitions(config, paths, python, log),
      {
        autoInstall: config.autoInstallBackends,
        startupTimeoutMs: config.backendStartupTimeoutMs,
        idleTimeoutMs: config.backendIdleTimeoutMs,
        runDir: join(paths.cacheDir, 'run'),
      },
      settings,
      log,
      logs,
    );
    this.python = python;
  }
}
