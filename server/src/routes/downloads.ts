import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { parseSlot } from '../models/bundle.js';
import { MODEL_KINDS } from '../paths.js';
import { startSse } from '../util/sse.js';

const statusEnum = z.enum(['queued', 'downloading', 'completed', 'failed', 'cancelled']);

/** Download management (requirement 8): abort, retry, delete, and live progress. */
export async function downloadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/downloads',
    {
      schema: {
        tags: ['downloads'],
        summary: 'List downloads',
        querystring: z.object({
          kind: z.enum(MODEL_KINDS).optional(),
          bundle: z.string().optional(),
          status: z.union([statusEnum, z.array(statusEnum)]).optional(),
        }),
        response: { 200: z.object({ downloads: z.array(z.unknown()) }) },
      },
    },
    async (req) => {
      const status = req.query.status
        ? Array.isArray(req.query.status)
          ? req.query.status
          : [req.query.status]
        : undefined;
      return { downloads: app.downloads.list({ kind: req.query.kind, bundle: req.query.bundle, status }) };
    },
  );

  app.post(
    '/v1/downloads',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Queue a download into a model bundle',
        body: z.object({
          kind: z.enum(MODEL_KINDS),
          bundle: z.string().min(1),
          slot: z.string(),
          url: z.string().url(),
          name: z.string().optional(),
        }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const task = await app.downloads.enqueue({
        kind: req.body.kind,
        bundle: req.body.bundle,
        slot: parseSlot(req.body.slot),
        url: req.body.url,
        name: req.body.name,
      });
      return reply.code(202).send(task);
    },
  );

  /**
   * The aggregate stream. sd-api only offered a per-task stream, so the
   * catalogue window had to open one SSE connection per in-flight download —
   * six concurrent downloads meant six connections, each with its own
   * heartbeat. One stream carrying every task's progress is what the UI's
   * download manager actually needs.
   */
  app.get(
    '/v1/downloads/stream',
    { schema: { tags: ['downloads'], summary: 'Live progress for all downloads (SSE)' } },
    async (req, reply) => {
      const stream = startSse(req, reply);
      for (const task of app.downloads.list({ status: ['queued', 'downloading'] })) {
        stream.send('task', task);
      }
      stream.onClose(app.downloads.subscribe(null, (event, task) => stream.send(event, task)));
    },
  );

  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/downloads/:id',
    {
      schema: {
        tags: ['downloads'],
        summary: 'One download',
        params: idParam,
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const task = app.downloads.get(req.params.id);
      if (!task) throw errors.downloadNotFound(req.params.id);
      return task;
    },
  );

  app.get(
    '/v1/downloads/:id/stream',
    {
      schema: { tags: ['downloads'], summary: 'Live progress for one download (SSE)', params: idParam },
    },
    async (req, reply) => {
      const task = app.downloads.get(req.params.id);
      if (!task) throw errors.downloadNotFound(req.params.id);

      const stream = startSse(req, reply);
      // Replay current state first: a client connecting to a download that is
      // already at 80% should see 80%, not wait for the next tick.
      stream.send('task', task);
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        stream.send('done', task);
        stream.close();
        return;
      }
      stream.onClose(app.downloads.subscribe(req.params.id, (event, data) => stream.send(event, data)));
    },
  );

  app.post(
    '/v1/downloads/:id/cancel',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Abort a download, keeping the partial file for a later resume',
        params: idParam,
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.downloads.cancel(req.params.id),
  );

  app.post(
    '/v1/downloads/:id/retry',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Retry a failed or cancelled download (resumes from its partial)',
        params: idParam,
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.downloads.retry(req.params.id),
  );

  app.delete(
    '/v1/downloads/:id',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Delete a download record',
        params: idParam,
        querystring: z.object({ discard: z.coerce.boolean().default(false) }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await app.downloads.remove(req.params.id, req.query.discard);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/downloads/resume',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Retry every failed or cancelled download',
        response: { 200: z.object({ downloads: z.array(z.unknown()) }) },
      },
    },
    async () => ({ downloads: app.downloads.resumeAll() }),
  );
}
