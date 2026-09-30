import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { startSse } from '../core/util/sse.js';
import { parseSlot } from '../models/bundle.js';
import { MODEL_KINDS } from '../paths.js';

/**
 * HuggingFace snapshot downloads for vLLM, which loads a whole repository
 * rather than files filed into a bundle. File downloads are shared
 * (`core/routes/downloads.ts`).
 */
export async function snapshotRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/downloads/snapshot',
    {
      schema: {
        tags: ['downloads'],
        summary: 'List HuggingFace snapshot downloads',
        response: { 200: z.object({ downloads: z.array(z.unknown()) }) },
      },
    },
    async () => ({ downloads: app.snapshotDownloads.list() }),
  );

  app.post(
    '/v1/downloads/snapshot',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Queue a whole-repo (or whole sub-folder) HuggingFace snapshot download into a model bundle',
        description:
          'For vLLM models: pulls the full repo (config, tokenizer, sharded weights) via ' +
          'huggingface-cli, rather than picking one component file. For a Python-backend model ' +
          'declaring `"source": { "snapshot": true } }` components (e.g. EchoMimicV3), pass `slot` ' +
          'so the pull lands in that component\'s own directory rather than the bundle root, and ' +
          '`path` when the component is a sub-folder of the repo rather than the whole thing.',
        body: z.object({
          kind: z.enum(MODEL_KINDS),
          bundle: z.string().min(1),
          repo: z.string().min(1),
          slot: z.string().optional(),
          path: z.string().optional(),
        }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const task = await app.snapshotDownloads.enqueue(req.body.kind, req.body.bundle, req.body.repo, {
        slot: req.body.slot ? parseSlot(req.body.slot) : undefined,
        path: req.body.path,
      });
      return reply.code(202).send(task);
    },
  );

  app.get(
    '/v1/downloads/snapshot/:id',
    {
      schema: {
        tags: ['downloads'],
        summary: 'One snapshot download',
        params: idParam,
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.snapshotDownloads.require(req.params.id),
  );

  app.get(
    '/v1/downloads/snapshot/stream',
    { schema: { tags: ['downloads'], summary: 'Live progress for all snapshot downloads (SSE)' } },
    async (req, reply) => {
      const stream = startSse(req, reply);
      for (const task of app.snapshotDownloads.list()) {
        if (task.status === 'downloading') stream.send('task', task);
      }
      stream.onClose(app.snapshotDownloads.subscribe(null, (event, task) => stream.send(event, task)));
    },
  );
}
