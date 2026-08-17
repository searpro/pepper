import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { detectGpuCount, vllmActiveModelKey } from '../backends/vllm.js';
import { proxyToBackend, type ProxyBody } from '../services/proxy.js';

/**
 * Direct vLLM-Omni surface (requirement: "vLLM-Omni as Inference Backend").
 *
 * A separate `/v1/vllm/*` namespace rather than folding these into the
 * existing `/v1/images`-shaped and `/v1/videos`-shaped routes: those are
 * pepper's own OpenAI-compatible surfaces backed by the sd-cli job queue, and
 * vLLM-Omni's *own* endpoints — same standard, different server, different
 * semantics (e.g. vLLM's `/v1/videos` takes multipart with an audio
 * reference and can run sync; pepper's takes an uploaded-file name and is
 * always async) — would collide with them under the same path. Proxying
 * byte-for-byte here keeps both surfaces honest about which backend actually
 * served the request. Chat completions are the one exception: llama.cpp and
 * vLLM speak the identical shape, so `/v1/llm/chat/completions` (routes/text.ts)
 * routes to whichever backend the requested model belongs to instead of
 * duplicating the endpoint here.
 */
export async function vllmRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Image/audio generation through a diffusion pipeline runs far longer than
  // an LLM completion; this mirrors sd-cli's own image timeout rather than
  // llama.cpp's.
  const GENERATION_TIMEOUT_MS = 600_000;

  const jsonProxy =
    (upstreamPath: string) =>
    async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'vllm',
        upstreamPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: GENERATION_TIMEOUT_MS,
      });

  app.post(
    '/v1/vllm/images/generations',
    {
      schema: {
        tags: ['text'],
        summary: 'Generate an image via vLLM-Omni (OpenAI images-compatible)',
        body: z.object({ prompt: z.string().min(1) }).passthrough(),
      },
    },
    jsonProxy('/v1/images/generations'),
  );

  app.post(
    '/v1/vllm/audio/generate',
    {
      schema: {
        tags: ['audio'],
        summary: 'Generate audio via vLLM-Omni',
        body: z.object({ input: z.string().min(1) }).passthrough(),
      },
    },
    jsonProxy('/v1/audio/generate'),
  );

  /**
   * vLLM-Omni's video endpoint takes `multipart/form-data` (prompt plus an
   * optional reference image/audio for speech-to-video), forwarded raw the
   * same way `/v1/audio/transcriptions` forwards to audio.cpp — see that
   * route for why the content-type parser has to be swapped out first.
   */
  app.removeContentTypeParser('multipart/form-data');
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null, undefined));

  const videoTimeoutMs = 3_600_000; // Generation can run minutes; sync mode blocks for the whole thing.

  app.post(
    '/v1/vllm/videos',
    {
      schema: {
        tags: ['videos'],
        summary: 'Create a video via vLLM-Omni, async (multipart; speech-to-video via audio_reference)',
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'vllm',
        upstreamPath: '/v1/videos',
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'multipart/form-data',
          ...(req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}),
        },
        body: Readable.toWeb(req.raw) as unknown as ProxyBody,
        timeoutMs: videoTimeoutMs,
      }),
  );

  app.post(
    '/v1/vllm/videos/sync',
    {
      schema: {
        tags: ['videos'],
        summary: 'Create a video via vLLM-Omni, blocking until the MP4 bytes come back',
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'vllm',
        upstreamPath: '/v1/videos/sync',
        method: 'POST',
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'multipart/form-data',
          ...(req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}),
        },
        body: Readable.toWeb(req.raw) as unknown as ProxyBody,
        timeoutMs: videoTimeoutMs,
      }),
  );

  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/vllm/videos/:id',
    { schema: { tags: ['videos'], summary: 'Poll a vLLM-Omni video job', params: idParam } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'vllm',
        upstreamPath: `/v1/videos/${encodeURIComponent(req.params.id)}`,
        method: 'GET',
        timeoutMs: 30_000,
      }),
  );

  app.get(
    '/v1/vllm/videos/:id/content',
    { schema: { tags: ['videos'], summary: 'Download a completed vLLM-Omni video', params: idParam } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'vllm',
        upstreamPath: `/v1/videos/${encodeURIComponent(req.params.id)}/content`,
        method: 'GET',
        timeoutMs: videoTimeoutMs,
      }),
  );

  // --- Model selection & GPU info --------------------------------------------
  //
  // vLLM cannot hot-swap models, so "which model" is a Preferences setting
  // (requirement: default backend/model selection lives in Preferences, not
  // the generation screen) rather than a per-request field. Writing it
  // restarts vLLM the same way a CLI-argument change does.

  app.get(
    '/v1/vllm/model',
    { schema: { tags: ['backends'], summary: 'The model id vLLM is currently configured to serve' } },
    async () => ({ modelId: app.settings.get(vllmActiveModelKey()) || null }),
  );

  app.put(
    '/v1/vllm/model',
    {
      schema: {
        tags: ['backends'],
        summary: 'Select the model vLLM serves',
        description: 'Restarts vLLM if it is running, with the new model.',
        body: z.object({ modelId: z.string().min(1) }),
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      app.settings.set(vllmActiveModelKey(), req.body.modelId);
      app.backends.scheduleRestart('vllm', `model changed to "${req.body.modelId}"`);
      return { modelId: req.body.modelId };
    },
  );

  app.get(
    '/v1/vllm/gpu-count',
    {
      schema: {
        tags: ['backends'],
        summary: 'Detected GPU count (nvidia-smi), for suggesting --tensor-parallel-size',
        response: { 200: z.object({ gpuCount: z.number() }) },
      },
    },
    async () => ({ gpuCount: await detectGpuCount() }),
  );
}
