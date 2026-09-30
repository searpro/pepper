import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LogBuffer, LogSource } from '../logs/buffer.js';
import { startSse, startWs, type SseStream } from '../util/sse.js';

/** Sources every product logs under; each adds its backends' ids. */
const CORE_SOURCES = ['app', 'http', 'healthcheck', 'job', 'download'];

export interface LogRoutesOptions {
  logs: LogBuffer;
  /** The product's backend ids, which are log sources too. */
  backendSources: string[];
}

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
export async function logRoutes(fastify: FastifyInstance, options: LogRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { logs } = options;
  const sources = [...CORE_SOURCES, ...options.backendSources];
  const sourceEnum = z.string().refine((value) => sources.includes(value), {
    message: `expected one of ${sources.join(', ')}`,
  });

  const filterSchema = z.object({
    search: z.string().optional(),
    source: z.union([sourceEnum, z.array(sourceEnum)]).optional(),
    minLevel: levelEnum.optional(),
    sinceSeq: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(5000).optional(),
  });

  function toSources(value: z.infer<typeof filterSchema>['source']): LogSource[] | undefined {
    if (!value) return undefined;
    return (Array.isArray(value) ? value : [value]) as LogSource[];
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
      records: logs.query({
        search: req.query.search,
        sources: toSources(req.query.source),
        minLevel: req.query.minLevel,
        sinceSeq: req.query.sinceSeq,
        limit: req.query.limit,
      }),
      sources,
    }),
  );

  function tail(query: z.infer<typeof filterSchema>, stream: SseStream): void {
    const filter = {
      search: query.search,
      sources: toSources(query.source),
      minLevel: query.minLevel,
    };
    // Replay a recent window before tailing, so the viewer opens with
    // context instead of an empty pane on an idle system.
    for (const record of logs.query({ ...filter, limit: query.limit ?? 200 })) {
      stream.send('record', record);
    }
    stream.onClose(logs.subscribe(filter, (record) => stream.send('record', record)));
  }

  app.route({
    method: 'GET',
    url: '/v1/logs/stream',
    schema: {
      tags: ['logs'],
      summary: 'Live log tail (SSE, or WebSocket on upgrade)',
      querystring: filterSchema,
    },
    handler: async (req, reply) => tail(req.query, startSse(req, reply)),
    wsHandler: (socket, req) => tail(req.query, startWs(socket)),
  });
}
