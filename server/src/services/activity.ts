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
 *
 * MCP traffic is judged by its JSON-RPC method, not its HTTP verb: every MCP
 * message is a POST, and a client connecting, listing tools or pinging is
 * housekeeping. An idle claude.ai chat with the connector enabled does that
 * on its own, and must not keep a GPU billing.
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

/** Whether a finished request counts as someone using Pepper. `body` is the parsed request body. */
export function isActivity(method: string, url: string, statusCode: number, body?: unknown): boolean {
  if (statusCode >= 400) return false; // rejected callers (bots, a wrong token) keep nothing alive
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const path = url.split('?')[0];
  if (path === '/v1/session') return false;
  if (path === '/mcp' || path.startsWith('/mcp/')) {
    // A JSON-RPC batch counts if any message in it is a tool call.
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((m) => (m as { method?: unknown } | null)?.method === 'tools/call');
  }
  return true;
}
