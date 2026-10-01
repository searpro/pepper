/// <reference types="@fastify/swagger" preserve="true" />
/// <reference types="@fastify/websocket" preserve="true" />
/// <reference types="@fastify/multipart" preserve="true" />
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import type Database from 'better-sqlite3';
import { redactTokenPath, registerAuthHook } from './auth.js';
import type { CoreConfig } from './config.js';
import { openDb, type Db, type ProductSchema } from './db/client.js';
import { SettingsStore } from './db/settings.js';
import { AppError } from './errors.js';
import { LogBuffer } from './logs/buffer.js';
import type { Paths } from './paths.js';
import { ActivityTracker, isActivity } from './services/activity.js';

/**
 * The Fastify application every product starts from: logging into the ring
 * buffer the Logs screen reads, the database, the token check, uploads,
 * WebSockets, OpenAPI docs, error mapping and the SPA fallback. A product
 * builds its services on what this returns, registers its routes, then calls
 * `serveSpa` last.
 */

export interface ProductInfo {
  /** Shown in the OpenAPI document. */
  title: string;
  description: string;
  version: string;
  /** OpenAPI tags beyond the shared ones. */
  tags: { name: string; description: string }[];
}

export interface CoreAppOptions {
  config: CoreConfig;
  paths: Paths;
  product: ProductInfo;
  schema?: ProductSchema;
}

export interface CoreApp {
  app: FastifyInstance;
  logs: LogBuffer;
  db: Db;
  sqlite: Database.Database;
  settings: SettingsStore;
  activity: ActivityTracker;
  /** Closing the database is not part of Fastify's lifecycle. */
  closeDb: () => void;
}

const CORE_TAGS = [
  { name: 'system', description: 'Health, configuration and credentials' },
  { name: 'backends', description: 'Backend lifecycle and CLI arguments' },
  { name: 'downloads', description: 'Weight downloads' },
  { name: 'jobs', description: 'Generation jobs' },
  { name: 'media', description: 'Outputs and uploads' },
  { name: 'logs', description: 'Log query and live tail' },
  { name: 'mcp', description: 'Model Context Protocol endpoint for Claude' },
];

export async function createCoreApp(options: CoreAppOptions): Promise<CoreApp> {
  const { config, paths, product } = options;

  // Tee every log line to stdout (so container logs are unchanged) and into
  // the ring buffer the UI's log viewer reads. Fastify's `logger` option only
  // takes options; a pre-built instance needs `loggerInstance`.
  const logs = new LogBuffer();
  // Typed as FastifyBaseLogger rather than the concrete pino.Logger: leaving
  // it inferred makes Fastify's Logger generic resolve to that concrete type,
  // which stops every route plugin (typed against the default) from matching.
  //
  // Each stream entry needs its own explicit level. `pino.multistream()`
  // defaults every destination to 'info' and does *not* inherit the logger's
  // own level, so without this a debug-level deployment silently drops every
  // backend line before it reaches stdout or the buffer.
  //
  // `redact` keeps the `/mcp/<token>` form of the API token (auth.ts) out
  // of every log line, including the stdout a Kaggle kernel posts back.
  const logger: FastifyBaseLogger = pino(
    {
      level: config.logLevel,
      redact: { paths: ['req.url', 'originalUrl', 'url'], censor: redactTokenPath },
    },
    pino.multistream([
      { stream: process.stdout, level: config.logLevel },
      { stream: logs, level: config.logLevel },
    ]),
  );

  const { db, sqlite, temporary } = openDb(
    paths.dbFile,
    (movedTo, reason) =>
      logger.error({ movedTo, reason }, 'the database was corrupt; set it aside and started a new one'),
    options.schema,
  );
  if (temporary) {
    logger.error(
      { file: paths.dbFile, reason: temporary },
      'the database cannot be written (is the data volume full?); keeping state in memory for this run — ' +
        'delete a model to free space, then restart',
    );
  }

  const app = Fastify({
    loggerInstance: logger,
    // Without this, close() hangs waiting for idle keep-alive sockets (an
    // OpenAI client's connection pool against /v1/llm/*, for one) to end on
    // their own, which Node's server.close() never forces.
    forceCloseConnections: true,
    // Generation payloads are small JSON; uploads go through multipart.
    bodyLimit: 4 * 1024 * 1024,
    requestTimeout: config.httpServerTimeoutMs,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const activity = new ActivityTracker();

  // First, so the token check covers every route below — /docs included.
  registerAuthHook(app, config.apiToken);
  app.addHook('onResponse', async (request, reply) => {
    if (isActivity(request.method, request.url, reply.statusCode, request.body)) activity.touch();
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 512 * 1024 * 1024 },
  });

  // Lets the live streams answer a WebSocket upgrade on their SSE URLs — see
  // util/sse.ts for why both transports exist.
  await app.register(fastifyWebsocket);

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: product.title, description: product.description, version: product.version },
      tags: [...CORE_TAGS, ...product.tags],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number; validation?: unknown };
    if (error instanceof AppError) {
      // Client mistakes are not incidents: logging a 404 at error level is how
      // a log viewer fills with noise and stops being read.
      const level = error.statusCode >= 500 ? 'error' : 'warn';
      request.log[level]({ err: error, code: error.code }, error.message);
      return reply.code(error.statusCode).send(error.toResponse());
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          details: error.issues,
        },
      });
    }

    // fastify-type-provider-zod wraps validation failures rather than
    // rethrowing the ZodError, so the branch above never sees them.
    const validation = (error as { validation?: unknown }).validation;
    if (validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, details: validation },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(error.statusCode ?? 500).send({
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    // Anything that is not an API call is the SPA's own routing: serve the
    // shell and let the client router resolve it, so a deep link works on a
    // hard refresh.
    // `/.well-known/` is not the SPA's either: MCP clients probe it for OAuth
    // metadata, and an HTML page with status 200 there makes Claude's
    // connector treat the server as OAuth-protected and fail. A 404 tells it
    // there is no OAuth, so it uses the token in the URL.
    if (
      !request.url.startsWith('/v1') &&
      !request.url.startsWith('/docs') &&
      !request.url.startsWith('/mcp') &&
      !request.url.startsWith('/.well-known/') &&
      request.method === 'GET'
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  return {
    app,
    logs,
    db,
    sqlite,
    settings: new SettingsStore(db),
    activity,
    closeDb: () => sqlite.close(),
  };
}

/**
 * The built SPA. Registered last so it never shadows an API route — its
 * wildcard route is the least specific thing in the tree, and a path it has
 * no file for falls through to the not-found handler, which serves the shell
 * so client-side routes survive a hard refresh.
 */
export async function serveSpa(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root });
}
