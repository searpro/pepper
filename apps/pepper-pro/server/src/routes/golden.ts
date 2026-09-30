import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '@pepper/core/errors.js';
import { contentType } from '@pepper/core/routes/media.js';
import type { GoldenService } from '../golden/service.js';
import type { ProPaths } from '../paths.js';

export interface GoldenRoutesOptions {
  golden: GoldenService;
  paths: ProPaths;
}

/** Golden shots: runs per recipe version, and the blind A/B between versions (golden/service.ts). */
export async function goldenRoutes(fastify: FastifyInstance, options: GoldenRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { golden, paths } = options;
  const tags = ['recipes'];

  app.get('/v1/golden', { schema: { tags, summary: 'The golden shots and the inputs they need' } }, async () => {
    const inputs = await Promise.all(
      Object.entries(golden.inputs).map(async ([name, spec]) => {
        const supplied = spec.supply ? join(paths.dataDir, 'golden', 'inputs', spec.supply) : undefined;
        const present = supplied
          ? await access(supplied).then(() => true, () => false)
          : undefined;
        return { name, kind: spec.kind, generate: spec.generate?.capability, supply: spec.supply ? { path: supplied, present, note: spec.note } : undefined };
      }),
    );
    return { shots: golden.shots, inputs };
  });

  app.get(
    '/v1/golden/runs',
    { schema: { tags, summary: 'Golden runs, newest first', querystring: z.object({ recipe: z.string().optional() }) } },
    async (req) => ({ runs: golden.listRuns(req.query.recipe) }),
  );

  app.post(
    '/v1/golden/runs',
    {
      schema: {
        tags,
        summary: "Render a recipe's golden shots with their fixed seeds",
        body: z.object({ recipe: z.string(), mode: z.string().optional() }),
      },
    },
    async (req, reply) => reply.code(202).send(golden.start(req.body.recipe, req.body.mode)),
  );

  app.get(
    '/v1/golden/files/*',
    { schema: { tags, summary: 'A kept golden result' } },
    async (req, reply) => {
      const file = (req.params as { '*': string })['*'];
      const path = golden.resultPath(file);
      try {
        await access(path);
      } catch {
        throw errors.outputNotFound(`golden/${file}`);
      }
      return reply.type(contentType(path)).send(createReadStream(path));
    },
  );

  app.get(
    '/v1/golden/pair',
    {
      schema: {
        tags,
        summary: 'A shot from two versions of a recipe, sides shuffled, for a blind vote',
        querystring: z.object({ recipe: z.string(), mode: z.string().default('final'), a: z.coerce.number().int().optional(), b: z.coerce.number().int().optional() }),
      },
    },
    async (req) => golden.pair(req.query.recipe, req.query.mode, req.query.a, req.query.b) ?? { done: true, versions: [] },
  );

  app.post(
    '/v1/golden/votes',
    {
      schema: {
        tags,
        summary: 'Record a blind vote; answers with the versions that were compared',
        body: z.object({
          recipe: z.string(),
          mode: z.string(),
          shot: z.string(),
          left: z.string(),
          right: z.string(),
          winner: z.enum(['left', 'right', 'tie']),
        }),
      },
    },
    async (req) => golden.vote(req.body),
  );

  app.get(
    '/v1/golden/tally',
    { schema: { tags, summary: 'Wins, losses and ties per recipe version', querystring: z.object({ recipe: z.string() }) } },
    async (req) => ({ versions: golden.tally(req.query.recipe) }),
  );
}
