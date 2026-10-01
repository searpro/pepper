import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { BackendManager } from '@pepper/core/backends/manager.js';
import { errors } from '@pepper/core/errors.js';
import type { JobManager } from '@pepper/core/jobs/manager.js';
import { errorResponseSchema, jobSchema } from '@pepper/core/schemas.js';
import { proxyToBackend } from '@pepper/core/services/proxy.js';
import type { ProConfig } from '../config.js';
import type { ComfyEngine } from '../engines/comfy.js';
import {
  ASPECT_RATIOS,
  describeModel,
  mapRequest,
  mismatch,
  pickModel,
  resolveRequestMedia,
  type GenericRequest,
  type ModelDescription,
} from '../generate.js';
import type { ProPaths } from '../paths.js';
import type { RecipeStore } from '../recipes/store.js';

export interface GenerateRoutesOptions {
  jobs: JobManager;
  comfy: ComfyEngine;
  backends: BackendManager;
  paths: ProPaths;
  recipes: RecipeStore;
  config: ProConfig;
  llamacppTimeoutMs: number;
}

const media = z.string().min(1);

/** One generation in generic terms (src/generate.ts); `model` is a recipe id. */
export const genericSchema = z.object({
  kind: z.enum(['image', 'video', 'audio']),
  model: z.string().optional().describe('A model id from GET /v1/models; the best installed fit when omitted.'),
  audio_type: z.enum(['speech', 'music']).optional().describe('audio only: picks the model family when model is omitted.'),
  prompt: z.string().max(8000).optional(),
  image: media.optional().describe('Start frame, subject or image to edit: a URL, data URI, upload or output name.'),
  end_image: media.optional(),
  reference_images: z.array(media).max(8).optional(),
  audio: media.optional(),
  audio_2: media.optional(),
  video: media.optional(),
  voice_reference: media.optional(),
  voice: z.string().max(500).optional(),
  lyrics: z.string().max(8000).optional(),
  duration: z.number().positive().optional(),
  aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
  quality: z.string().optional(),
  seed: z.number().int().min(0).optional(),
  count: z.number().int().min(1).max(8).optional(),
  params: z.record(z.unknown()).optional(),
});

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
  const { jobs, comfy, recipes, config } = options;

  const models = async (): Promise<ModelDescription[]> =>
    Promise.all(recipes.list().map(async (r) => describeModel(r, await recipes.status(r, config.tier, config.licenceMode))));

  app.get(
    '/v1/models',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Models for POST /v1/generate',
        description: 'Each recipe in generic terms: the inputs it takes, durations, aspect ratios, qualities, and whether it can run here.',
        querystring: z.object({ kind: z.enum(['image', 'video', 'audio']).optional() }),
      },
    },
    async (req) => ({ models: (await models()).filter((m) => !req.query.kind || m.kind === req.query.kind) }),
  );

  app.post(
    '/v1/generate',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Generate an image, video or audio clip in generic terms',
        description:
          'Like POST /v1/jobs, but with model-independent fields (prompt, image, end_image, reference_images, ' +
          'audio, duration, aspect_ratio, quality) mapped onto the chosen recipe, and media given by URL, data URI, ' +
          'upload or output name. Without `model`, the best installed model that takes every input given is used.',
        body: genericSchema,
      },
    },
    async (req, reply) => {
      const { kind, model, audio_type, count, ...fields } = req.body;
      const all = await models();
      let chosen: ModelDescription;
      if (model) {
        recipes.require(model); // a 404 naming the id, if there is no such recipe
        chosen = all.find((m) => m.id === model)!;
        if (chosen.kind !== kind) throw errors.validation(`${model} makes ${chosen.kind}, not ${kind}`);
        // Install state and licence are the engine's to report, with their own codes.
        const why = mismatch({ ...chosen, unavailable: undefined }, fields as GenericRequest);
        if (why) throw errors.validation(`${model} ${why} (list_models shows what each model takes)`);
      } else {
        chosen = pickModel(kind, fields as GenericRequest, all, audio_type);
      }
      const request = await resolveRequestMedia(fields as GenericRequest, { uploadsDir: options.paths.uploadsDir, outputDir: options.paths.outputDir });
      const recipe = recipes.require(chosen.id);
      const { mode, params } = mapRequest(recipe, request);
      const created = [];
      for (let i = 0; i < (count ?? 1); i++) {
        const prepared = await comfy.prepareRequest({ recipe: recipe.id, mode, params });
        created.push(jobs.create(prepared.recipe.kind, { recipe: prepared.recipe.id, mode: prepared.mode, params: prepared.values }));
      }
      return reply.code(202).send({ model: chosen.id, quality: mode, jobs: created });
    },
  );

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
