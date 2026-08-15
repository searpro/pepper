import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { manifestSchema, parseSlot, KIND_SLOTS } from '../models/bundle.js';
import { MODEL_KINDS } from '../paths.js';

/**
 * Installed models (requirement 8). One route family covers all four kinds —
 * `/v1/models/:kind/...` — where sd-api had three parallel trees
 * (`/v1/models`, `/v1/llm-models`, `/v1/audio-models`) that had already
 * drifted apart. The old paths are preserved by `routes/compat.ts`.
 */
export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const kindParam = z.object({ kind: z.enum(MODEL_KINDS) });
  const bundleParams = kindParam.extend({ bundle: z.string() });

  app.get(
    '/v1/models',
    {
      schema: {
        tags: ['models'],
        summary: 'List every installed model bundle',
        querystring: z.object({
          kind: z.enum(MODEL_KINDS).optional(),
          ready: z.coerce.boolean().optional(),
        }),
        response: { 200: z.object({ models: z.array(z.unknown()) }) },
      },
    },
    async (req) => {
      const models = await app.models.list(req.query.kind);
      return {
        models: req.query.ready === undefined ? models : models.filter((m) => m.ready === req.query.ready),
      };
    },
  );

  app.get(
    '/v1/models/slots',
    {
      schema: {
        tags: ['models'],
        summary: 'Component slots available per model kind',
        description:
          'Drives the "add to bundle" picker. Any other value may be supplied as ' +
          '"other:<directory>", which creates that directory inside the bundle.',
        response: { 200: z.record(z.array(z.string())) },
      },
    },
    async () => KIND_SLOTS,
  );

  // There is deliberately no `GET /v1/models/:kind` list route: sd-api's
  // `GET /v1/models/:model` occupies that exact shape, and Fastify cannot tell
  // `:kind` from `:model` at one segment. Filtering by kind is
  // `GET /v1/models?kind=`, which loses nothing — the compatibility path is
  // the one with no alternative spelling.

  app.post(
    '/v1/models/:kind',
    {
      schema: {
        tags: ['models'],
        summary: 'Create an empty model bundle',
        params: kindParam,
        body: z.object({ id: z.string().min(1), manifest: manifestSchema.optional() }),
        response: { 201: z.unknown() },
      },
    },
    async (req, reply) => {
      const bundle = await app.models.create(req.params.kind, req.body.id, req.body.manifest);
      return reply.code(201).send(bundle);
    },
  );

  app.get(
    '/v1/models/:kind/:bundle',
    {
      schema: {
        tags: ['models'],
        summary: 'Inspect one model bundle',
        params: bundleParams,
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.models.get(req.params.kind, req.params.bundle),
  );

  app.put(
    '/v1/models/:kind/:bundle/manifest',
    {
      schema: {
        tags: ['models'],
        summary: 'Update a bundle’s model.json',
        params: bundleParams,
        body: manifestSchema,
        response: { 200: z.unknown() },
      },
    },
    async (req) => {
      const bundle = await app.models.updateManifest(req.params.kind, req.params.bundle, req.body);
      // Audio's registry is generated from these manifests, so a family/task
      // edit only takes effect once the backend has been restarted with the
      // regenerated config.
      if (req.params.kind === 'audio') {
        app.backends.scheduleRestart('audiocpp', 'audio model manifest changed');
      }
      return bundle;
    },
  );

  app.delete(
    '/v1/models/:kind/:bundle',
    {
      schema: {
        tags: ['models'],
        summary: 'Delete a model bundle and all of its files',
        params: bundleParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await app.models.remove(req.params.kind, req.params.bundle);
      if (req.params.kind === 'audio') {
        app.backends.scheduleRestart('audiocpp', 'audio model deleted');
      }
      if (req.params.kind === 'llm') {
        app.backends.scheduleRestart('llamacpp', 'llm model deleted');
      }
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/v1/models/:kind/:bundle/:slot/:name',
    {
      schema: {
        tags: ['models'],
        summary: 'Delete one component file from a bundle',
        params: bundleParams.extend({ slot: z.string(), name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await app.models.removeComponent(
        req.params.kind,
        req.params.bundle,
        parseSlot(req.params.slot),
        req.params.name,
      );
      return reply.code(204).send(null);
    },
  );

  /**
   * Add a file to an existing bundle (requirement 8's "Support Add to
   * bundle"). The slot is what makes LORA / checkpoint / VAE / "other
   * (specify)" one endpoint rather than four: an unrecognised slot of the form
   * `other:<dir>` creates that directory and puts the file in it.
   */
  app.post(
    '/v1/models/:kind/:bundle/components',
    {
      schema: {
        tags: ['models'],
        summary: 'Download a file into a bundle',
        params: bundleParams,
        body: z.object({
          slot: z.string(),
          url: z.string().url(),
          name: z.string().optional(),
        }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const task = await app.downloads.enqueue({
        kind: req.params.kind,
        bundle: req.params.bundle,
        slot: parseSlot(req.body.slot),
        url: req.body.url,
        name: req.body.name,
      });
      return reply.code(202).send(task);
    },
  );

  app.post(
    '/v1/models/:kind/:bundle/rename',
    {
      schema: {
        tags: ['models'],
        summary: 'Rename a bundle',
        params: bundleParams,
        body: z.object({ id: z.string().min(1) }),
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.models.rename(req.params.kind, req.params.bundle, req.body.id),
  );

  /** Resume a partial download discovered on disk rather than in the task table. */
  app.post(
    '/v1/models/:kind/:bundle/resume',
    {
      schema: {
        tags: ['models'],
        summary: 'Resume an interrupted component download',
        params: bundleParams,
        body: z.object({ slot: z.string(), name: z.string() }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const task = await app.downloads.resumePartial(
        req.params.kind,
        req.params.bundle,
        parseSlot(req.body.slot),
        req.body.name,
      );
      return reply.code(202).send(task);
    },
  );
}
