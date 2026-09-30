import type { FastifyBaseLogger } from 'fastify';
import type { BackendManager } from '../backends/manager.js';
import type { JobExecutor, JobKind, JobManager } from '../jobs/manager.js';

/**
 * A generation engine: the job kinds it runs and the lifecycle of whatever
 * holds its memory.
 *
 * The job system dispatches by kind and knows nothing about sd-cli, llama.cpp
 * or ComfyUI; an engine is what turns a job of its kinds into outputs. The
 * split exists so the platform code (jobs, downloads, logs, media, MCP) can be
 * shared by products whose engines differ entirely — Pepper drives sd-cli,
 * audio.cpp and one-shot Python runners, Pepper Pro drives ComfyUI — while the
 * one piece of cross-engine policy both need, "free the GPU for the job about
 * to run", lives in one place (`EngineRegistry.exclusive`).
 */
export interface Engine {
  readonly id: string;
  readonly label: string;
  /** Job kinds this engine executes; registered with `JobManager` at startup. */
  executors(): Partial<Record<JobKind, JobExecutor>>;
  /**
   * Install or verify binaries and environments. Runs in the background after
   * the server listens, so it must never be what a health check waits on.
   */
  prepare?(signal?: AbortSignal): Promise<void>;
  /**
   * Release the memory this engine holds while idle, so another engine can
   * run. A no-op for engines that hold nothing between jobs. The engine loads
   * again on its next job, so this trades a reload for headroom.
   */
  release?(reason: ReleaseReason): Promise<void>;
  /** Whether the engine currently holds model memory while idle. */
  resident?(): boolean;
  /** Stop everything on shutdown. */
  shutdown?(): Promise<void>;
}

export type ReleaseReason = 'swap' | 'idle' | 'pressure' | 'shutdown';

export interface EngineStatus {
  id: string;
  label: string;
  kinds: JobKind[];
  resident: boolean;
}

/**
 * What services see of the registry: enough to make room for themselves,
 * without a dependency on every other engine.
 */
export interface MemoryArbiter {
  /**
   * Release every *other* engine that is holding memory. Called by an engine
   * immediately before work that needs the whole GPU (and, on unified memory,
   * the whole machine).
   */
  exclusive(engineId: string, log?: (line: string) => void): Promise<void>;
  /** Release one engine by id; unknown ids are ignored. */
  release(engineId: string, reason: ReleaseReason): Promise<void>;
}

export class EngineRegistry implements MemoryArbiter {
  private readonly engines = new Map<string, Engine>();
  private readonly kinds = new Map<JobKind, string>();

  constructor(private readonly log: FastifyBaseLogger) {}

  /** Add an engine. Two engines claiming one job kind is a wiring mistake, so it throws. */
  register(engine: Engine): this {
    if (this.engines.has(engine.id)) throw new Error(`Engine "${engine.id}" is registered twice`);
    for (const kind of Object.keys(engine.executors()) as JobKind[]) {
      const owner = this.kinds.get(kind);
      if (owner) throw new Error(`Job kind "${kind}" is claimed by both "${owner}" and "${engine.id}"`);
      this.kinds.set(kind, engine.id);
    }
    this.engines.set(engine.id, engine);
    return this;
  }

  /** Register every engine's executors with the job system. */
  attach(jobs: JobManager): void {
    for (const engine of this.engines.values()) {
      for (const [kind, executor] of Object.entries(engine.executors()) as [JobKind, JobExecutor][]) {
        jobs.registerExecutor(kind, executor);
      }
    }
  }

  get(id: string): Engine | undefined {
    return this.engines.get(id);
  }

  list(): Engine[] {
    return [...this.engines.values()];
  }

  /** Which engine runs a job kind. */
  ownerOf(kind: JobKind): Engine | undefined {
    const id = this.kinds.get(kind);
    return id ? this.engines.get(id) : undefined;
  }

  async exclusive(engineId: string, log?: (line: string) => void): Promise<void> {
    for (const engine of this.engines.values()) {
      if (engine.id === engineId || !engine.release) continue;
      if (engine.resident && !engine.resident()) continue;
      log?.(`Releasing ${engine.label} to free memory for ${this.engines.get(engineId)?.label ?? engineId}`);
      await engine
        .release('swap')
        .catch((err) => this.log.warn({ engine: engine.id, err }, 'could not release engine'));
    }
  }

  async release(engineId: string, reason: ReleaseReason): Promise<void> {
    const engine = this.engines.get(engineId);
    if (!engine?.release) return;
    if (engine.resident && !engine.resident()) return;
    await engine.release(reason).catch((err) => this.log.warn({ engine: engineId, err }, 'could not release engine'));
  }

  /** Prepare every engine in turn. Each failure is logged, never thrown: one engine's install must not take the others down. */
  async prepareAll(signal?: AbortSignal): Promise<void> {
    for (const engine of this.engines.values()) {
      if (!engine.prepare) continue;
      await engine.prepare(signal).catch((err) => {
        this.log.warn({ engine: engine.id, err: (err as Error).message }, 'engine could not be prepared');
      });
    }
  }

  async shutdown(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.shutdown?.().catch(() => {});
    }
  }

  status(): EngineStatus[] {
    return this.list().map((engine) => ({
      id: engine.id,
      label: engine.label,
      kinds: [...this.kinds.entries()].filter(([, id]) => id === engine.id).map(([kind]) => kind),
      resident: engine.resident?.() ?? false,
    }));
  }
}

/**
 * An engine backed by one supervised server process (llama.cpp, audio.cpp):
 * resident while it runs, released by stopping it. It restarts on its next
 * request.
 */
export function processEngine(
  backends: BackendManager,
  backend: string,
  label: string,
  executors: ReturnType<Engine['executors']>,
): Engine {
  const running = () => {
    const proc = backends.get(backend);
    return Boolean(proc && proc.status !== 'stopped' && proc.status !== 'failed');
  };
  return {
    id: backend,
    label,
    executors: () => executors,
    resident: running,
    release: async () => {
      if (!running()) return;
      await backends.get(backend)?.stop();
    },
  };
}
