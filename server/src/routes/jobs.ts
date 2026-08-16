import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  audioJobSchema,
  errorResponseSchema,
  generateSchema,
  jobSchema,
  textJobSchema,
  validateDimensions,
} from '../schemas/generate.js';
import { errors } from '../errors.js';
import { startSse } from '../util/sse.js';
import type { JobKind } from '../jobs/manager.js';

/**
 * Jobs (requirement 4) and synchronous generation.
 *
 * `POST /v1/generate` is kept because sd-api clients use it, but it is now a
 * thin wrapper over the same queue rather than a second, unbounded path into
 * the generator — that separation is what let sd-api's synchronous route spawn
 * as many model loads as it received requests and get the server OOM-killed.
 */
export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const kindEnum = z.enum(['image', 'video', 'audio', 'text']);
  const statusEnum = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

  /** Image and video share one request shape; the bundle decides which it is. */
  async function jobKindFor(model: string, audio?: string): Promise<JobKind> {
    const bundle = await app.models.find(model, ['image', 'video']);
    if (!bundle) throw errors.modelNotFound(model);

    // Rejecting an audio request against a model that cannot use it here means
    // a clear 400 in milliseconds, rather than a job that queues, loads
    // several gigabytes of weights and produces a video ignoring the speech.
    if (audio && !bundle.capabilities.includes('s2v')) {
      throw errors.validation(
        `Model "${model}" does not support speech-to-video. Choose a model whose ` +
          'capabilities include "s2v".',
      );
    }
    return bundle.mode === 'video' ? 'video' : 'image';
  }

  app.post(
    '/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Enqueue a generation job',
        description:
          'Preferred for anything long-running. Stream progress from GET /v1/jobs/:id/stream.',
        body: generateSchema,
        response: { 202: z.union([jobSchema, z.object({ jobs: z.array(jobSchema) })]), 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      validateDimensions(req.body, 8192);
      const kind = await jobKindFor(req.body.model, req.body.audio);

      // `batch` fans out to one job per image rather than one job producing
      // several: each gets its own progress, its own abort, and its own retry,
      // which is what the job viewer needs to be useful.
      const count = req.body.batch ?? 1;
      const { batch: _batch, ...params } = req.body;
      const created = Array.from({ length: count }, () => app.jobs.create(kind, params));

      return reply.code(202).send(count === 1 ? created[0] : { jobs: created });
    },
  );

  /**
   * Audio and text get their own enqueue routes rather than a discriminated
   * union on `POST /v1/jobs`: their bodies share no field with the image shape
   * beyond `model`, so one schema covering all four would validate almost
   * nothing and produce unusable errors on a typo.
   */
  app.post(
    '/v1/jobs/audio',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Enqueue a speech generation job',
        description:
          'The queued counterpart of POST /v1/audio/speech, which stays synchronous. ' +
          'Voice-design models require `instructions`; models with packaged speakers take `voice`.',
        body: audioJobSchema,
        response: { 202: jobSchema, 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const bundle = await app.models.find(req.body.model, ['audio']);
      if (!bundle) throw errors.modelNotFound(req.body.model);
      return reply.code(202).send(app.jobs.create('audio', req.body));
    },
  );

  app.post(
    '/v1/jobs/text',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Enqueue a text generation job',
        description:
          'The queued counterpart of POST /v1/llm/chat/completions. Non-streaming: ' +
          'a job collects a whole result, so `stream` is ignored.',
        body: textJobSchema,
        response: { 202: jobSchema, 400: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const bundle = await app.models.find(req.body.model, ['llm']);
      if (!bundle) throw errors.modelNotFound(req.body.model);
      return reply.code(202).send(app.jobs.create('text', req.body));
    },
  );

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
      return { jobs: app.jobs.list({ kind: req.query.kind, status, limit: req.query.limit }) };
    },
  );

  /** Live updates for every job — what the Job viewer subscribes to. */
  app.get(
    '/v1/jobs/stream',
    { schema: { tags: ['jobs'], summary: 'Live updates for all jobs (SSE)' } },
    async (req, reply) => {
      const stream = startSse(req, reply);
      for (const job of app.jobs.list({ status: ['queued', 'running'] })) {
        stream.send('updated', job);
      }
      stream.onClose(app.jobs.subscribe(null, (event, data) => stream.send(event, data)));
    },
  );

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
    async (req) => app.jobs.require(req.params.id),
  );

  app.get(
    '/v1/jobs/:id/stream',
    { schema: { tags: ['jobs'], summary: 'Progress and logs for one job (SSE)', params: idParam } },
    async (req, reply) => {
      const job = app.jobs.require(req.params.id);
      const stream = startSse(req, reply);
      stream.send('updated', job);

      // A client attaching to an already-finished job gets its terminal event
      // and a closed stream, rather than an open connection that never speaks.
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        stream.send(job.status === 'completed' ? 'completed' : 'failed', job);
        stream.close();
        return;
      }

      stream.onClose(
        app.jobs.subscribe(req.params.id, (event, data) => {
          stream.send(event, data);
          if (event === 'completed' || event === 'failed') stream.close();
        }),
      );
    },
  );

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
    async (req) => app.jobs.cancel(req.params.id),
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
    async (req) => app.jobs.retry(req.params.id),
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
      app.jobs.remove(req.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * Synchronous generation, for sd-api compatibility. Enqueues and waits.
   */
  app.post(
    '/v1/generate',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Generate and wait for the result',
        description:
          'Convenience wrapper over the job queue: enqueues, waits, and returns the result. ' +
          'Long generations are better served by POST /v1/jobs plus the SSE stream, since this ' +
          'holds the HTTP connection open for the whole run.',
        body: generateSchema,
        response: { 200: z.unknown(), 400: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (req) => {
      validateDimensions(req.body, 8192);
      const kind = await jobKindFor(req.body.model, req.body.audio);
      const { batch: _batch, ...params } = req.body;
      const job = app.jobs.create(kind, params);

      return new Promise((resolvePromise, reject) => {
        const unsubscribe = app.jobs.subscribe(job.id, (event, data) => {
          if (event !== 'completed' && event !== 'failed') return;
          unsubscribe();
          const finished = data as { result?: Record<string, unknown>; error?: { code: string; message: string } };
          if (event === 'completed') resolvePromise(finished.result ?? {});
          else {
            reject(
              errors.generationFailed(finished.error?.message ?? 'Generation failed'),
            );
          }
        });

        // The connection can outlive the client. Dropping the subscription on
        // disconnect keeps a long-abandoned request from holding a listener
        // on the job manager forever.
        req.raw.on('aborted', () => unsubscribe());
      });
    },
  );
}
