import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DownloadManager } from '../downloads/manager.js';
import { errors } from '../errors.js';
import { startSse, startWs, type SseStream } from '../util/sse.js';

const statusEnum = z.enum(['queued', 'downloading', 'completed', 'failed', 'cancelled']);

/** Download management (requirement 8): abort, retry, delete, and live progress. */
export interface DownloadRoutesOptions {
  // `any`: the manager's kind and slot types are the product's; this plugin
  // only moves strings between the wire and the manager, which validates them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  downloads: DownloadManager<any, any>;
  /** The product's model kinds, the first coordinate of a download. */
  kinds: readonly [string, ...string[]];
}

export async function downloadRoutes(fastify: FastifyInstance, options: DownloadRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { downloads } = options;
  const kindEnum = z.enum(options.kinds as [string, ...string[]]);

  app.get(
    '/v1/downloads',
    {
      schema: {
        tags: ['downloads'],
        summary: 'List downloads',
        querystring: z.object({
          kind: kindEnum.optional(),
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
      return { downloads: downloads.list({ kind: req.query.kind, bundle: req.query.bundle, status }) };
    },
  );

  app.post(
    '/v1/downloads',
    {
      schema: {
        tags: ['downloads'],
        summary: 'Queue a download into a model bundle',
        body: z.object({
          kind: kindEnum,
          bundle: z.string().min(1),
          slot: z.string(),
          url: z.string().url(),
          name: z.string().optional(),
        }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const task = await downloads.enqueue({
        kind: req.body.kind,
        bundle: req.body.bundle,
        slot: req.body.slot,
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
  function allDownloads(stream: SseStream): void {
    for (const task of downloads.list({ status: ['queued', 'downloading'] })) {
      stream.send('task', task);
    }
    stream.onClose(downloads.subscribe(null, (event, task) => stream.send(event, task)));
  }

  app.route({
    method: 'GET',
    url: '/v1/downloads/stream',
    schema: {
      tags: ['downloads'],
      summary: 'Live progress for all downloads (SSE, or WebSocket on upgrade)',
    },
    handler: async (req, reply) => allDownloads(startSse(req, reply)),
    wsHandler: (socket) => allDownloads(startWs(socket)),
  });

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
      const task = downloads.get(req.params.id);
      if (!task) throw errors.downloadNotFound(req.params.id);
      return task;
    },
  );

  function oneDownload(id: string, stream: SseStream): void {
    const task = downloads.get(id);
    if (!task) {
      stream.close();
      return;
    }
    // Replay current state first: a client connecting to a download that is
    // already at 80% should see 80%, not wait for the next tick.
    stream.send('task', task);
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      stream.send('done', task);
      stream.close();
      return;
    }
    stream.onClose(downloads.subscribe(id, (event, data) => stream.send(event, data)));
  }

  app.route({
    method: 'GET',
    url: '/v1/downloads/:id/stream',
    schema: {
      tags: ['downloads'],
      summary: 'Live progress for one download (SSE, or WebSocket on upgrade)',
      params: idParam,
    },
    handler: async (req, reply) => {
      // Checked before the stream opens so an unknown id is a plain 404.
      if (!downloads.get(req.params.id)) throw errors.downloadNotFound(req.params.id);
      oneDownload(req.params.id, startSse(req, reply));
    },
    wsHandler: (socket, req) => oneDownload(req.params.id, startWs(socket)),
  });

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
    async (req) => downloads.cancel(req.params.id),
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
    async (req) => downloads.retry(req.params.id),
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
      await downloads.remove(req.params.id, req.query.discard);
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
    async () => ({ downloads: downloads.resumeAll() }),
  );

  // --- HuggingFace snapshot downloads (vLLM models) --------------------------
  //
  // A whole-repo pull, not a single component file — see
  // `downloads/snapshot.ts` for why this is a separate, simpler tracker
  // rather than a `DownloadManager` task.
}
