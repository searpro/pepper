import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { proxyToBackend } from '../services/proxy.js';

/**
 * Text generation (requirement 3): an OpenAI-shaped reverse proxy onto
 * llama.cpp's server.
 *
 * Only `model` (plus the endpoint's own required field) is validated; every
 * other key rides through via `.passthrough()`. Without it,
 * `fastify-type-provider-zod` replaces `request.body` with the *parsed* value
 * and silently strips anything unmodelled — `tools`, `response_format`,
 * multimodal content parts, and whatever llama.cpp adds next — which turns a
 * working client request into a subtly different one.
 */
export async function textRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /** Forward a validated JSON body to llama.cpp unchanged. */
  const forward = (upstreamPath: string) =>
    async (req: FastifyRequest, reply: FastifyReply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'llamacpp',
        upstreamPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: app.config.llamacppTimeoutMs,
      });

  app.post(
    '/v1/llm/chat/completions',
    {
      schema: {
        tags: ['text'],
        summary: 'Chat completion (OpenAI-compatible)',
        body: z
          .object({
            model: z.string().min(1),
            messages: z.array(z.unknown()).min(1),
          })
          .passthrough(),
      },
    },
    forward('/v1/chat/completions'),
  );

  app.post(
    '/v1/llm/completions',
    {
      schema: {
        tags: ['text'],
        summary: 'Text completion (OpenAI-compatible)',
        body: z.object({ model: z.string().min(1), prompt: z.unknown() }).passthrough(),
      },
    },
    forward('/v1/completions'),
  );

  app.post(
    '/v1/llm/embeddings',
    {
      schema: {
        tags: ['text'],
        summary: 'Embeddings (OpenAI-compatible)',
        body: z.object({ model: z.string().min(1), input: z.unknown() }).passthrough(),
      },
    },
    forward('/v1/embeddings'),
  );

  app.get(
    '/v1/llm/models',
    { schema: { tags: ['text'], summary: 'Models llama.cpp has loaded' } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'llamacpp',
        upstreamPath: '/v1/models',
        method: 'GET',
        timeoutMs: 30_000,
      }),
  );
}
