import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pythonActiveModelKey } from '../backends/python.js';
import { proxyToBackend, type ProxyBody } from '../services/proxy.js';

/**
 * The Python backend's surface (requirement 5's forward-looking item, now
 * that something — EchoMimicV3 — actually runs against it).
 *
 * Like vLLM, the Python backend spawns one model per process and cannot
 * hot-swap, so "which model" is a Preferences setting (`/v1/python/model`)
 * rather than a per-request field — see `routes/vllm.ts`'s identical reasoning.
 *
 * Unlike vLLM, there is no fixed, documented HTTP contract to translate:
 * `python_entrypoint` is whatever script the catalogue entry names, and what
 * it exposes (a Gradio app's routes, ComfyUI's `/prompt`, or something else
 * entirely) is a property of *that* script, not something pepper can know in
 * general. So rather than modelling endpoints it cannot verify, this proxies
 * every request under `/v1/python/*` straight through to the spawned
 * process's own root, unparsed and unmodified — the same "byte for byte"
 * principle `proxyToBackend` already applies to vLLM's video multipart, just
 * with no fixed path list.
 */
export async function pythonRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/python/model',
    { schema: { tags: ['backends'], summary: 'The model id the Python backend is currently configured to serve' } },
    async () => ({ modelId: app.settings.get(pythonActiveModelKey()) || null }),
  );

  app.put(
    '/v1/python/model',
    {
      schema: {
        tags: ['backends'],
        summary: 'Select the model the Python backend serves',
        description:
          'Restarts the Python backend if it is running, with the newly selected model — once its ' +
          '`python_package` has been installed (POST /v1/backends/python/install).',
        body: z.object({ modelId: z.string().min(1) }),
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      app.settings.set(pythonActiveModelKey(), req.body.modelId);
      app.backends.scheduleRestart('python', `model changed to "${req.body.modelId}"`);
      return { modelId: req.body.modelId };
    },
  );

  const PROXY_TIMEOUT_MS = 3_600_000; // Generation can run minutes on CPU-bound hardware.

  // Isolated in its own encapsulated sub-plugin: a generic proxy has to
  // accept whatever content-type the entrypoint's own surface expects, so
  // every parser is disabled here in favour of forwarding the raw body —
  // without that isolation, disabling the JSON parser would also break the
  // `/v1/python/model` route above, which needs its JSON body parsed.
  await app.register(async (proxy) => {
    proxy.removeContentTypeParser(['application/json', 'text/plain']);
    proxy.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

    proxy.all(
      '/v1/python/proxy/*',
      {
        schema: {
          tags: ['backends'],
          summary: "Raw reverse proxy to the Python backend's own HTTP surface",
          description:
            'Forwards method, headers and body unmodified to whatever the selected model\'s entrypoint ' +
            'exposes at that path. The exact surface (Gradio routes, a custom API, …) is model-specific.',
        },
      },
      async (req, reply) => {
        const wildcard = (req.params as Record<string, string>)['*'] ?? '';
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        await proxyToBackend(app.backends, req, reply, {
          backend: 'python',
          upstreamPath: `/${wildcard}${query}`,
          method: req.method,
          headers: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : undefined,
          body: Readable.toWeb(req.raw) as unknown as ProxyBody,
          timeoutMs: PROXY_TIMEOUT_MS,
        });
      },
    );
  });
}
