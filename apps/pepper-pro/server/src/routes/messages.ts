import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BackendManager } from '@pepper/core/backends/manager.js';
import type { GpuLanes } from '@pepper/core/engines/gpu.js';
import { proxyToBackend } from '@pepper/core/services/proxy.js';
import { AGENT_MODEL_ID, type AgentLlm } from '../llm/agent.js';

/**
 * Anthropic's Messages API on the agent model, so Claude Code can run on
 * this box's GPU: `ANTHROPIC_BASE_URL` at this server, the API token as
 * `ANTHROPIC_AUTH_TOKEN`. llama.cpp speaks the API itself; what this adds is
 * the GPU's order. A request takes the `llm` lane through the llama.cpp
 * gate, so it waits while renders run or are queued, then frees ComfyUI and
 * loads the model (restoring its saved slot).
 *
 * That wait can last as long as a render queue, and two things would cut it
 * short: Cloudflare's tunnel drops a response with no bytes after 100 s, and
 * Claude Code gives up on a silent stream. So a streamed request is answered
 * with SSE headers once it has waited a while, and pings until llama.cpp's
 * own stream starts (clients ignore `ping` events). A request that is not
 * streamed cannot be kept alive that way, so it gets `529 overloaded_error`
 * before the tunnel's limit, which Claude Code retries by itself.
 */
export interface MessagesRoutesOptions {
  backends: BackendManager;
  agent: AgentLlm;
  gpu: GpuLanes;
  /** Ceiling on one request once the GPU is ours; 0 for none. */
  timeoutMs: number;
}

const PING_EVERY_MS = 15_000;
/** Under Cloudflare's 100 s, with room for the 529 to get back through it. */
const UNSTREAMED_WAIT_MS = 85_000;

type Body = Record<string, unknown>;

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}

export async function messagesRoutes(fastify: FastifyInstance, options: MessagesRoutesOptions): Promise<void> {
  const app = fastify;
  const { backends, agent } = options;

  const disabled = (reply: FastifyReply) =>
    reply
      .code(404)
      .header('content-type', 'application/json')
      .send(anthropicError('not_found_error', 'No agent model on this server: set LLM_AGENT_MODEL (see .env.example).'));

  app.post(
    '/v1/messages',
    {
      // Claude Code sends the whole conversation, images included, every turn.
      bodyLimit: 64 * 1024 * 1024,
      schema: { tags: ['text'], summary: 'Anthropic Messages API on the agent model, for Claude Code (llama.cpp)' },
    },
    async (req, reply) => {
      if (!agent.enabled) return disabled(reply);
      await relay(req, reply, { ...(req.body as Body), model: AGENT_MODEL_ID });
    },
  );

  app.post(
    '/v1/messages/count_tokens',
    {
      bodyLimit: 64 * 1024 * 1024,
      schema: { tags: ['text'], summary: 'Count tokens for a Messages request (estimated while the GPU is rendering)' },
    },
    async (req, reply) => {
      if (!agent.enabled) return disabled(reply);
      const body: Body = { ...(req.body as Body), model: AGENT_MODEL_ID };
      // Counting is not worth a GPU swap: with llama.cpp stopped or the card
      // busy, an estimate (about 3.5 characters a token) is answer enough.
      if (backends.gated('llamacpp') || backends.get('llamacpp')?.status !== 'ready') {
        const text = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]);
        return { input_tokens: Math.ceil(text.length / 3.5) };
      }
      return proxyToBackend(backends, req, reply, {
        backend: 'llamacpp',
        upstreamPath: '/v1/messages/count_tokens',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      });
    },
  );

  // For the status line of a Claude Code on the agent model (deploy/home/llm/statusline.mjs).
  app.get(
    '/v1/llm/gpu',
    { schema: { tags: ['text'], summary: 'Who holds the GPU now: renders, the language model, and who waits' } },
    async () => ({
      ...options.gpu.state(),
      llamacpp: backends.get('llamacpp')?.status ?? 'stopped',
      agent: agent.enabled,
    }),
  );

  async function relay(req: FastifyRequest, reply: FastifyReply, body: Body): Promise<void> {
    const stream = body.stream === true;
    const res = reply.raw;
    reply.hijack();

    const controller = new AbortController();
    let overloaded = false;
    // `close` before the response finished is the client hanging up (see proxy.ts on why `res`, not `req`).
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    };
    const pinger = setInterval(() => {
      if (!stream) return;
      commit();
      res.write('event: ping\ndata: {"type": "ping"}\n\n');
    }, PING_EVERY_MS);
    const giveUp = stream
      ? null
      : setTimeout(() => {
          overloaded = true;
          controller.abort();
        }, UNSTREAMED_WAIT_MS);
    let ceiling: NodeJS.Timeout | null = null;

    const fail = (status: number, type: string, message: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (committed) {
        res.end(`event: error\ndata: ${anthropicError(type, message)}\n\n`);
      } else {
        res.writeHead(status, { 'content-type': 'application/json' }).end(anthropicError(type, message));
      }
    };

    let lease: Awaited<ReturnType<BackendManager['acquire']>> = null;
    try {
      lease = await backends.acquire('llamacpp', controller.signal);
      if (giveUp) clearTimeout(giveUp);
      if (!lease) return fail(503, 'api_error', 'llama.cpp is not installed on this server yet.');
      await agent.prepare(controller.signal);
      if (options.timeoutMs > 0) {
        ceiling = setTimeout(() => controller.abort(), options.timeoutMs);
        ceiling.unref();
      }

      const upstream = await fetch(`${backends.baseUrl('llamacpp')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearInterval(pinger);

      if (!upstream.ok && committed) {
        const text = await upstream.text();
        return fail(upstream.status, 'api_error', `llama.cpp answered HTTP ${upstream.status}: ${text.slice(0, 500)}`);
      }
      if (!committed) {
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      }
      if (!upstream.body) {
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } catch (err) {
      if (overloaded) {
        return fail(529, 'overloaded_error', 'The GPU is rendering; retry shortly.');
      }
      if (controller.signal.aborted) {
        // The client hung up, or the ceiling fired; nobody is left to tell.
        if (!res.headersSent) res.writeHead(499);
        res.end();
        return;
      }
      // A failure to start llama.cpp is worth a retry, which Claude Code makes for an overload.
      req.log.warn({ err: (err as Error).message }, 'agent model request failed');
      fail(529, 'overloaded_error', `The agent model could not answer: ${(err as Error).message}`);
    } finally {
      clearInterval(pinger);
      if (giveUp) clearTimeout(giveUp);
      if (ceiling) clearTimeout(ceiling);
      lease?.release();
    }
  }
}
