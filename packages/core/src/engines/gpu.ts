/**
 * Who may use the GPU next, on a card too small to hold a render and the
 * language model at once.
 *
 * Two lanes. `job` is a generation (one ComfyUI job at a time); `llm` is a
 * request to llama.cpp (a chat turn, a plan, a Claude Code turn), any number
 * at once since llama.cpp queues them itself. Renders go first: an `llm`
 * request waits while a job runs *or* is queued, and a job waits only for the
 * requests already running. The order comes from how an agent works — it
 * queues renders and then waits for them, and every poll is a model turn, so
 * letting turns in between jobs would swap a 20 GB model in and out of VRAM
 * on each poll for nothing. A job that arrives mid-turn waits for that turn
 * (seconds), not for the conversation.
 *
 * Who actually frees memory is not decided here: callers still call
 * `MemoryArbiter.exclusive()` once they hold their lane. This class only
 * orders them, so the release always happens with nothing on the other lane.
 *
 * With `shared` off (a card big enough for both), the `llm` lane never waits
 * and jobs still run one at a time.
 */
export type GpuLane = 'job' | 'llm';

export interface GpuHolder {
  lane: GpuLane;
  label: string;
  since: number;
}

export interface GpuState {
  shared: boolean;
  holders: GpuHolder[];
  /** Requests waiting for each lane, oldest first. */
  waiting: { lane: GpuLane; label: string; since: number }[];
}

/** A finished wait on the `llm` lane: how long a turn sat behind renders. */
export interface GpuPause {
  from: number;
  to: number;
}

interface Waiter {
  lane: GpuLane;
  label: string;
  since: number;
  fromJob: boolean;
  /** Called with the release function of the holder `poke` created for it. */
  grant: (release: () => void) => void;
}

export class GpuLanes {
  private readonly holders = new Set<GpuHolder>();
  private readonly waiters: Waiter[] = [];
  private pause: GpuPause | null = null;
  private pauseSeen = true;

  /**
   * `pendingJobs` counts generation jobs queued or running; it is what keeps
   * a turn behind a queue whose next job has not reached its executor yet.
   * Call `poke()` whenever it may have dropped.
   */
  constructor(
    private readonly pendingJobs: () => number,
    private shared = true,
  ) {}

  setShared(shared: boolean): void {
    this.shared = shared;
    this.poke();
  }

  /** Run `fn` holding `lane`. `signal` aborts the wait only, like `Semaphore.run`. */
  async run<T>(lane: GpuLane, label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(lane, label, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Hold `lane` until the returned function is called (it is safe to call
   * twice). `fromJob` marks an `llm` request made by a running job (a plan, a
   * check): it waits for the card, not for the queue, since the jobs queued
   * behind it cannot start until it finishes.
   */
  async acquire(lane: GpuLane, label: string, signal?: AbortSignal, fromJob = false): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    const since = Date.now();
    if (!this.mustWait(lane, fromJob) && !this.waiters.some((w) => w.lane === lane || w.lane === 'job')) {
      return this.hold(lane, label);
    }
    const release = await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        label,
        since,
        fromJob,
        grant: (held) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(held);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(abortError());
        this.poke();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      // It may be able to run now: waiting only behind a waiter it is allowed to pass.
      this.poke();
    });
    // A turn that sat behind renders is what the agent is told about next.
    if (lane === 'llm' && !fromJob && Date.now() - since > 5_000) {
      this.pause = { from: since, to: Date.now() };
      this.pauseSeen = false;
    }
    return release;
  }

  /** Whether an `llm` request made now would have to wait. */
  llmWouldWait(): boolean {
    return this.mustWait('llm') || this.waiters.some((w) => w.lane === 'job');
  }

  /** The last time a turn waited for renders, once: later calls get null until the next pause. */
  takePause(): GpuPause | null {
    if (this.pauseSeen || !this.pause) return null;
    this.pauseSeen = true;
    return this.pause;
  }

  state(): GpuState {
    return {
      shared: this.shared,
      holders: [...this.holders].map((h) => ({ ...h })),
      waiting: this.waiters.map(({ lane, label, since }) => ({ lane, label, since })),
    };
  }

  /** Grant whatever can run now: queued jobs first, then every waiting turn. */
  poke(): void {
    for (const lane of ['job', 'llm'] as const) {
      for (let i = 0; i < this.waiters.length; ) {
        const waiter = this.waiters[i];
        if (waiter.lane !== lane || this.mustWait(lane, waiter.fromJob)) {
          i++;
          continue;
        }
        this.waiters.splice(i, 1);
        // The holder exists from this moment, so the next waiter in this pass sees it.
        waiter.grant(this.hold(lane, waiter.label));
      }
    }
  }

  private mustWait(lane: GpuLane, fromJob = false): boolean {
    const held = [...this.holders];
    // Jobs run one at a time; on a shared card they also wait out running turns.
    if (lane === 'job') return held.some((h) => h.lane === 'job' || this.shared);
    if (!this.shared) return false;
    return held.some((h) => h.lane === 'job') || (!fromJob && this.pendingJobs() > 0);
  }

  private hold(lane: GpuLane, label: string): () => void {
    const holder: GpuHolder = { lane, label, since: Date.now() };
    this.holders.add(holder);
    return () => {
      if (!this.holders.delete(holder)) return;
      this.poke();
    };
  }
}

function abortError(): Error {
  return new DOMException('Aborted while waiting for the GPU', 'AbortError');
}
