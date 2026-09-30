import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BackendManager } from '@pepper/core/backends/manager.js';
import { errors } from '@pepper/core/errors.js';
import type { JobManager } from '@pepper/core/jobs/manager.js';
import { errorResponseSchema, jobSchema } from '@pepper/core/schemas.js';
import { proxyToBackend } from '@pepper/core/services/proxy.js';
import type { ComfyEngine } from '../engines/comfy.js';
import type { ProPaths } from '../paths.js';

export interface GenerateRoutesOptions {
  jobs: JobManager;
  comfy: ComfyEngine;
  backends: BackendManager;
  paths: ProPaths;
  llamacppTimeoutMs: number;
}

export const recipeJobSchema = z.object({
  recipe: z.string().min(1),
  mode: z.string().optional(),
  params: z.record(z.unknown()).default({}),
  /** Several takes of the same request, each with its own seed unless one is given. */
  batch: z.number().int().min(1).max(16).optional(),
});

/**
 * Generation outside a project: run one recipe with parameters. Takes of a
 * shot go through the project routes, which use the same engine.
 */
export async function generateRoutes(fastify: FastifyInstance, options: GenerateRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { jobs, comfy } = options;

  app.post(
    '/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Run a recipe',
        description:
          'Checks the recipe is installed and allowed, resolves its parameters (drawing a seed if none ' +
          'is given, so the job reproduces), and queues it. Follow it on GET /v1/jobs/:id/stream.',
        body: recipeJobSchema,
        response: { 202: z.union([jobSchema, z.object({ jobs: z.array(jobSchema) })]), 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const count = req.body.batch ?? 1;
      const created = [];
      for (let i = 0; i < count; i++) {
        const { recipe, mode, values } = await comfy.prepareRequest(req.body);
        created.push(jobs.create(recipe.kind, { recipe: recipe.id, mode, params: values }));
      }
      return reply.code(202).send(count === 1 ? created[0] : { jobs: created });
    },
  );

  app.post(
    '/v1/jobs/text',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Queue a text completion on llama.cpp',
        body: z.object({
          model: z.string().min(1),
          messages: z.array(z.object({ role: z.string(), content: z.unknown() })).optional(),
          prompt: z.string().optional(),
          max_tokens: z.number().int().positive().optional(),
          temperature: z.number().min(0).max(2).optional(),
        }),
        response: { 202: jobSchema },
      },
    },
    async (req, reply) => {
      if (!req.body.messages && !req.body.prompt) throw errors.validation('Give messages or prompt');
      return reply.code(202).send(jobs.create('text', req.body));
    },
  );

  app.get(
    '/v1/llm/models',
    { schema: { tags: ['text'], summary: 'GGUF models llama.cpp can serve' } },
    async () => {
      const names = await readdir(options.paths.llmDir).catch(() => [] as string[]);
      return { models: names.filter((n) => n.endsWith('.gguf')).map((n) => ({ id: n.replace(/\.gguf$/, ''), file: n })) };
    },
  );

  // OpenAI-compatible chat, streamed straight through, for clients that want tokens as they come.
  app.post(
    '/v1/llm/chat/completions',
    { schema: { tags: ['text'], summary: 'OpenAI-compatible chat completions (llama.cpp)' } },
    async (req, reply) =>
      proxyToBackend(options.backends, req, reply, {
        backend: 'llamacpp',
        upstreamPath: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: options.llamacppTimeoutMs,
      }),
  );
}
