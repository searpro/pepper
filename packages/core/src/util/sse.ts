import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';

/**
 * Server-sent events, used identically by the job, download and log streams.
 *
 * Writing to `reply.raw` directly rather than returning a stream is what lets
 * a handler push events from an EventEmitter subscription. The two details
 * that matter:
 *
 * - **Disconnect is detected on `reply.raw`, not `req.raw`.** Node's
 *   `IncomingMessage` fires `close` as soon as the request body is fully read,
 *   which for a GET is immediately — wiring cleanup to it tears every stream
 *   down before the first event is sent. The response object is what actually
 *   tracks the socket.
 * - **A heartbeat comment is required.** Proxies (and RunPod's ingress) close
 *   idle connections, and a log stream on a quiet system is idle by
 *   definition.
 *
 * The streams the web app uses are also served over a WebSocket on the same
 * URL (`startWs`), because Cloudflare quick tunnels — how a Kaggle deployment
 * is reached — do not pass SSE through at all, while WebSockets work. The
 * route code is shared: it only ever sees an `SseStream`.
 */

const HEARTBEAT_MS = 15_000;

export interface SseStream {
  send(event: string, data: unknown): void;
  /** Register work to run when the client disconnects. */
  onClose(fn: () => void): void;
  close(): void;
}

export function startSse(req: FastifyRequest, reply: FastifyReply): SseStream {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers text/event-stream by default, which turns a live tail into
    // a batch delivered at the end.
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const cleanups: (() => void)[] = [];

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // A failing cleanup must not stop the others from running.
      }
    }
    reply.raw.end();
  };

  reply.raw.on('close', close);
  reply.raw.on('error', close);

  return {
    send(event, data) {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) {
      cleanups.push(fn);
    },
    close,
  };
}

/**
 * The same stream over a WebSocket: each event is one text frame of
 * `{"event": ..., "data": ...}`. Ping frames play the heartbeat's part.
 */
export function startWs(socket: WebSocket): SseStream {
  let closed = false;
  const cleanups: (() => void)[] = [];

  const heartbeat = setInterval(() => {
    if (!closed) socket.ping();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // A failing cleanup must not stop the others from running.
      }
    }
    // 1000 tells the client the stream ended on purpose (a finished job), so
    // it does not reconnect the way it would after a dropped connection.
    socket.close(1000);
  };

  socket.on('close', close);
  socket.on('error', close);

  return {
    send(event, data) {
      if (closed || socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ event, data }));
    },
    onClose(fn) {
      cleanups.push(fn);
    },
    close,
  };
}
