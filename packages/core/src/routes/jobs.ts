import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { JobManager } from '../jobs/manager.js';
import { errorResponseSchema, jobKindSchema, jobSchema, jobStatusSchema } from '../schemas.js';
import { startSse, startWs, type SseStream } from '../util/sse.js';

export interface JobRoutesOptions {
  jobs: JobManager;
}

/**
 * Job management shared by every product (requirement 4): list, follow,
 * cancel, retry and delete. How a job is *created* is each product's own
 * route, because the request shapes are its own.
 */
export async function coreJobRoutes(fastify: FastifyInstance, options: JobRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { jobs } = options;
  const kindEnum = jobKindSchema;
  const statusEnum = jobStatusSchema;

  app.get(
    '/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'List jobs',
        querystring: z.object({
          kind: kindEnum.optional(),
          status: z.union([statusEnum, z.array(statusEnum)]).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
        response: { 200: z.object({ jobs: z.array(jobSchema) }) },
      },
    },
    async (req) => {
      const status = req.query.status
        ? Array.isArray(req.query.status)
          ? req.query.status
          : [req.query.status]
        : undefined;
      return { jobs: jobs.list({ kind: req.query.kind, status, limit: req.query.limit }) };
    },
  );

  /** Live updates for every job — what the Job viewer subscribes to. */
  function allJobs(stream: SseStream): void {
    for (const job of jobs.list({ status: ['queued', 'running'] })) {
      stream.send('updated', job);
    }
    stream.onClose(jobs.subscribe(null, (event, data) => stream.send(event, data)));
  }

  app.route({
    method: 'GET',
    url: '/v1/jobs/stream',
    schema: { tags: ['jobs'], summary: 'Live updates for all jobs (SSE, or WebSocket on upgrade)' },
    handler: async (req, reply) => allJobs(startSse(req, reply)),
    wsHandler: (socket) => allJobs(startWs(socket)),
  });

  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Job status',
        params: idParam,
        response: { 200: jobSchema, 404: errorResponseSchema },
      },
    },
    async (req) => jobs.require(req.params.id),
  );

  function oneJob(id: string, stream: SseStream): void {
    const job = jobs.get(id);
    if (!job) {
      stream.close();
      return;
    }
    stream.send('updated', job);

    // A client attaching to an already-finished job gets its terminal event
    // and a closed stream, rather than an open connection that never speaks.
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      stream.send(job.status === 'completed' ? 'completed' : 'failed', job);
      stream.close();
      return;
    }

    stream.onClose(
      jobs.subscribe(id, (event, data) => {
        stream.send(event, data);
        if (event === 'completed' || event === 'failed') stream.close();
      }),
    );
  }

  app.route({
    method: 'GET',
    url: '/v1/jobs/:id/stream',
    schema: {
      tags: ['jobs'],
      summary: 'Progress and logs for one job (SSE, or WebSocket on upgrade)',
      params: idParam,
    },
    handler: async (req, reply) => {
      // Checked before the stream opens so an unknown id is a plain 404.
      jobs.require(req.params.id);
      oneJob(req.params.id, startSse(req, reply));
    },
    wsHandler: (socket, req) => oneJob(req.params.id, startWs(socket)),
  });

  app.post(
    '/v1/jobs/:id/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Abort a queued or running job',
        params: idParam,
        response: { 200: jobSchema },
      },
    },
    async (req) => jobs.cancel(req.params.id),
  );

  app.post(
    '/v1/jobs/:id/retry',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Re-run a finished job with its original parameters',
        params: idParam,
        response: { 200: jobSchema, 409: errorResponseSchema },
      },
    },
    async (req) => jobs.retry(req.params.id),
  );

  app.delete(
    '/v1/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Delete a job (aborting it first if it is running)',
        params: idParam,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      jobs.remove(req.params.id);
      return reply.code(204).send(null);
    },
  );

}
