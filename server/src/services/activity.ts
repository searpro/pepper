/**
 * How long Pepper has been idle, for hosts that bill by the second.
 *
 * A RunPod pod costs money whether or not anyone is using it, so its
 * entrypoint (deploy/runpod/entrypoint.mjs) terminates the pod after a
 * configurable idle period, and it needs a definition of idle that a
 * forgotten browser tab cannot defeat. Reads therefore do not count: the web
 * app polls status every few seconds for as long as it is open. What counts
 * is doing something — any successful non-GET request (generating, installing,
 * an MCP tool call) — and work still in progress: a queued or running job, or
 * an active download, keeps the server busy however long ago it was asked for.
 */
export class ActivityTracker {
  private last = Date.now();

  touch(): void {
    this.last = Date.now();
  }

  /** Seconds since the last activity; 0 while `busy`, which also counts as activity. */
  snapshot(busy: boolean): { lastActivityAt: string; idleSeconds: number; busy: boolean } {
    if (busy) this.touch();
    return {
      lastActivityAt: new Date(this.last).toISOString(),
      idleSeconds: Math.floor((Date.now() - this.last) / 1000),
      busy,
    };
  }
}

/** Whether a finished request counts as someone using Pepper. */
export function isActivity(method: string, url: string, statusCode: number): boolean {
  if (statusCode >= 400) return false; // rejected callers (bots, a wrong token) keep nothing alive
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return url.split('?')[0] !== '/v1/session';
}
