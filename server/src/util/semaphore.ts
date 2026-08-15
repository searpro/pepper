/**
 * A FIFO counting semaphore for async work.
 *
 * Every backend loads a multi-gigabyte model into memory, so the number of
 * simultaneously running generations has to be bounded — two concurrent runs
 * mean two resident copies, which on a typical GPU box does not degrade
 * gracefully, it gets the server OOM-killed. Callers wait rather than being
 * rejected: someone asking for three images wants three images, and a queue
 * makes that slow instead of fatal.
 */
export class Semaphore {
  private held = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
  }

  get inUse(): number {
    return this.held;
  }

  get queued(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.permits;
  }

  /**
   * Change the permit count at runtime (the Preferences screen can retune
   * `MAX_CONCURRENT_JOBS` without a restart). Raising it releases waiters
   * immediately; lowering it never revokes a permit already granted, so
   * in-flight work is left alone and the reduction takes effect as runs finish.
   */
  resize(permits: number): void {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
    const grew = permits - this.permits;
    this.permits = permits;
    for (let i = 0; i < grew && this.held < this.permits; i++) {
      this.waiters.shift()?.();
    }
  }

  /**
   * Run `fn` once a permit is free, releasing it afterwards.
   *
   * `signal` aborts the *wait* only — once `fn` has started it owns
   * cancellation, which for a generation means killing the child process.
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());

    if (this.held < this.permits) {
      this.held++;
      return Promise.resolve();
    }

    return new Promise<void>((resolvePromise, reject) => {
      const grant = () => {
        cleanup();
        this.held++;
        resolvePromise();
      };
      const onAbort = () => {
        // Drop this waiter without touching `held` — it never got a permit.
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
        cleanup();
        reject(abortError());
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);

      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.held--;
    // Hand the slot straight to the next waiter rather than decrementing and
    // letting whoever calls acquire() next take it — otherwise a caller
    // arriving at the right moment jumps the queue.
    this.waiters.shift()?.();
  }
}

function abortError(): Error {
  return new DOMException('Aborted while waiting for a slot', 'AbortError');
}
