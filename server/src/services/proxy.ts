import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BackendId } from '../config.js';
import { errors } from '../errors.js';
import type { BackendManager } from '../backends/manager.js';

/**
 * Reverse-proxies a request to a supervised backend, byte for byte.
 *
 * One code path serves JSON, binary audio and SSE alike, because the body is
 * never buffered or reshaped — it is piped straight through. That is what
 * keeps token streaming working without a second streaming-specific branch to
 * keep in sync.
 *
 * **Abort-on-disconnect must watch `reply.raw`, not `req.raw`.** Node's
 * `IncomingMessage` fires `close` once the request body has been fully read —
 * not when the client actually goes away — so wiring the abort controller to
 * it aborts the upstream fetch on *every* request, immediately, before a
 * single byte comes back. The symptom is an empty 200 with no body on every
 * call. The response object is what tracks the socket closing early.
 */

/**
 * What can be forwarded upstream. Typed here rather than as DOM's `BodyInit`,
 * which is not in scope for a Node-only `lib` setting.
 */
export type ProxyBody = string | Buffer | Uint8Array | Readable | unknown;

export interface ProxyOptions {
  backend: BackendId;
  /** Path (and query) on the upstream server. */
  upstreamPath: string;
  /** Body to forward. Omit for GET. */
  body?: ProxyBody | null;
  /** Headers to forward. Content-type in particular. */
  headers?: Record<string, string>;
  method?: string;
  timeoutMs: number;
}

export async function proxyToBackend(
  backends: BackendManager,
  req: FastifyRequest,
  reply: FastifyReply,
  options: ProxyOptions,
): Promise<void> {
  const process = await backends.ensureRunning(options.backend);
  if (!process) {
    throw errors.backendUnavailable(
      options.backend,
      `${options.backend} is not running — no models are installed for it yet`,
    );
  }
  // Feeds the idle-recycle rule: a backend serving traffic must never be
  // recycled out from under a request.
  process.markActivity();

  const controller = new AbortController();
  const onClientGone = () => controller.abort();
  reply.raw.on('close', onClientGone);

  // 0 means "no ceiling", which long completions legitimately need.
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;
  timer?.unref();

  try {
    const upstream = await fetch(`${backends.baseUrl(options.backend)}${options.upstreamPath}`, {
      method: options.method ?? req.method,
      headers: options.headers,
      body: options.body ?? undefined,
      signal: controller.signal,
      // Required by undici whenever the body is a stream.
      ...(options.body instanceof Readable || isWebStream(options.body) ? { duplex: 'half' } : {}),
    } as RequestInit);

    const headers: Record<string, string> = {};
    for (const header of ['content-type', 'content-length', 'cache-control', 'transfer-encoding']) {
      const value = upstream.headers.get(header);
      // Content-length and transfer-encoding are recomputed by Node for the
      // downstream response; copying them can contradict what is actually sent.
      if (value && header !== 'content-length' && header !== 'transfer-encoding') {
        headers[header] = value;
      }
    }

    reply.raw.writeHead(upstream.status, headers);

    if (!upstream.body) {
      reply.raw.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]),
      reply.raw,
    );
  } catch (err) {
    if (controller.signal.aborted) {
      // The client hung up, or the ceiling fired. Either way there is nobody
      // left to send an error to.
      if (!reply.raw.headersSent) reply.raw.writeHead(499).end();
      return;
    }
    throw errors.backendUpstreamError(
      options.backend,
      `${options.backend} request failed: ${(err as Error).message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    reply.raw.off('close', onClientGone);
    process.markActivity();
  }
}

function isWebStream(value: unknown): boolean {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}
