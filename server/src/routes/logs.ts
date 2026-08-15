import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { startSse } from '../util/sse.js';
import type { LogSource } from '../logs/buffer.js';

const sourceEnum = z.enum([
  'app',
  'http',
  'healthcheck',
  'job',
  'download',
  'sdcpp',
  'llamacpp',
  'audiocpp',
  'python',
]);

const levelEnum = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * The log viewer's API (requirement 10: "Support search, filtering by type,
 * state etc - realtime").
 *
 * Filtering happens server-side rather than in the browser. On a busy
 * generation the buffer turns over thousands of records a minute, and shipping
 * all of them so the client can hide most is what makes a log viewer feel
 * broken — the filter has to apply to the live stream too, not just the
 * snapshot.
 */
export async function logRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const filterSchema = z.object({
    search: z.string().optional(),
    source: z.union([sourceEnum, z.array(sourceEnum)]).optional(),
    minLevel: levelEnum.optional(),
    sinceSeq: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  });

  function toSources(value: z.infer<typeof filterSchema>['source']): LogSource[] | undefined {
    if (!value) return undefined;
    return Array.isArray(value) ? value : [value];
  }

  app.get(
    '/v1/logs',
    {
      schema: {
        tags: ['logs'],
        summary: 'Query buffered log records',
        querystring: filterSchema,
        response: {
          200: z.object({
            records: z.array(z.unknown()),
            sources: z.array(z.string()),
          }),
        },
      },
    },
    async (req) => ({
      records: app.logs.query({
        search: req.query.search,
        sources: toSources(req.query.source),
        minLevel: req.query.minLevel,
        sinceSeq: req.query.sinceSeq,
        limit: req.query.limit,
      }),
      sources: sourceEnum.options,
    }),
  );

  app.get(
    '/v1/logs/stream',
    {
      schema: {
        tags: ['logs'],
        summary: 'Live log tail (SSE)',
        querystring: filterSchema,
      },
    },
    async (req, reply) => {
      const filter = {
        search: req.query.search,
        sources: toSources(req.query.source),
        minLevel: req.query.minLevel,
      };

      const stream = startSse(req, reply);
      // Replay a recent window before tailing, so the viewer opens with
      // context instead of an empty pane on an idle system.
      for (const record of app.logs.query({ ...filter, limit: req.query.limit ?? 200 })) {
        stream.send('record', record);
      }
      stream.onClose(app.logs.subscribe(filter, (record) => stream.send('record', record)));
    },
  );
}
