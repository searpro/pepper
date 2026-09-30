import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Upscaler management for Pepper's own upscale engines (spandrel and
 * sd-cli). Outputs and uploads themselves are shared (`core/routes/media.ts`).
 */
export async function upscalerRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/upscalers',
    {
      schema: {
        tags: ['media'],
        summary: 'Installed upscaler checkpoints, the scales they make available, and the catalogue',
      },
    },
    async () => {
      const models = await app.upscaler.listModels();
      const [x2, x4] = await Promise.all([
        app.upscaler.defaultModel(2),
        app.upscaler.defaultModel(4),
      ]);
      return {
        dir: app.upscaler.dir,
        models: models.map(({ path: _path, ...model }) => model),
        scales: await app.upscaler.availableScales(),
        preferences: app.upscaler.preferences(),
        defaults: { 2: x2?.name ?? null, 4: x4?.name ?? null },
        pythonReady: await app.pythonVideo.runtimeInstalled(),
        catalogue: await app.upscaler.catalogue(),
      };
    },
  );

  app.put(
    '/v1/upscalers/preferences',
    {
      schema: {
        tags: ['media'],
        summary: 'Set the upscaler engine and the default checkpoint per scale',
        body: z.object({
          engine: z.enum(['auto', 'python', 'sdcpp']).optional(),
          default_x2: z.string().nullable().optional(),
          default_x4: z.string().nullable().optional(),
        }),
      },
    },
    async (req) => app.upscaler.setPreferences(req.body),
  );

  app.post(
    '/v1/upscalers/install',
    {
      schema: {
        tags: ['media'],
        summary: 'Download an upscaler from the curated catalogue',
        description: 'Resolves once the checkpoint is on disk; the files are 5–140 MB.',
        body: z.object({ id: z.string().min(1) }),
      },
    },
    async (req) => {
      await app.upscaler.install(req.body.id);
      return { ok: true };
    },
  );

  app.delete(
    '/v1/upscalers/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Delete an installed upscaler checkpoint',
        params: z.object({ name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await app.upscaler.remove(req.params.name);
      return reply.code(204).send(null);
    },
  );

}
