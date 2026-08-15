import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { manifestSchema, parseSlot, type BundleInfo, type ComponentSlot } from '../models/bundle.js';
import type { DownloadTask } from '../downloads/manager.js';
import { safeResolve, type ModelKind } from '../paths.js';
import { proxyToBackend } from '../services/proxy.js';
import { startSse } from '../util/sse.js';

/**
 * sd-api compatibility layer (requirement 11: "API contract should be fully
 * compatible with the current sd-api you can add new endpoints / modify
 * existing while maintaining backward compatibility").
 *
 * Viceroy is in production against sd-api's paths and response shapes, so
 * those keep working exactly as they did while the new unified surface exists
 * alongside. Everything here delegates to the same services the modern routes
 * use and translates at the edges — there is no second implementation of
 * anything, only a second spelling.
 *
 * The two translations that matter:
 * - `/v1/models` vs `/v1/llm-models` vs `/v1/audio-models` become the `kind`
 *   parameter of one route family.
 * - The legacy bundle shape (`checkpoint`/`vae`/`clip`/`loras` as distinct
 *   keys) is projected out of the new flat `components[]` array.
 */

/** Project a bundle into sd-api's response shape. */
function toLegacyBundle(bundle: BundleInfo): Record<string, unknown> {
  const bySlot = (slot: ComponentSlot) => bundle.components.filter((c) => c.slot === slot);
  const first = (slot: ComponentSlot) => {
    const files = bySlot(slot);
    if (files.length === 0) return null;
    const picked = [...files].sort((a, b) => b.size - a.size)[0];
    return { name: picked.name, size: picked.size };
  };

  return {
    id: bundle.id,
    name: bundle.name,
    loadMode: bundle.loadMode,
    mode: bundle.mode,
    checkpoint: first('checkpoint') ?? first('weights'),
    vae: first('vae'),
    clip: bySlot('clip').map((file) => ({ name: file.name, size: file.size, role: file.role })),
    loras: bySlot('lora').map((file) => ({ name: file.name, ref: file.ref, size: file.size })),
    size: bundle.size,
    modified: bundle.modified,
    ready: bundle.ready,
    partials: bundle.partials.map((partial) => ({
      type: partial.slot,
      name: partial.name,
      received: partial.received,
      total: partial.total,
    })),
    // New fields are additive: a legacy client ignores them, a new one can use
    // the same endpoint without a second round trip.
    kind: bundle.kind,
    components: bundle.components,
  };
}

/** Project a download task into sd-api's response shape. */
function toLegacyTask(task: DownloadTask): Record<string, unknown> {
  return {
    id: task.id,
    model: task.bundle,
    type: task.slot,
    name: task.name,
    url: task.url,
    status: task.status,
    received: task.received,
    total: task.total,
    // sd-api exposed this; it is derivable from the bytes already on disk when
    // the run started, and no client branches on it, so it is reported as
    // false rather than reintroducing the field into the task table.
    resumed: false,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    kind: task.kind,
    bundle: task.bundle,
    slot: task.slot,
  };
}

/** Legacy component types map onto slots one-for-one, except LLM/audio weights. */
function legacySlot(kind: ModelKind, type: string): ComponentSlot {
  if (kind === 'llm' && type === 'gguf') return 'weights';
  if (kind === 'llm' && type === 'mmproj') return 'aux';
  return parseSlot(type);
}

export async function compatRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // --- Model routes, one registration per legacy prefix ----------------------

  const modelPrefixes: [prefix: string, kind: ModelKind][] = [
    ['/v1/models', 'image'],
    ['/v1/llm-models', 'llm'],
    ['/v1/audio-models', 'audio'],
  ];

  for (const [prefix, kind] of modelPrefixes) {
    // `GET /v1/models` is the modern list-everything route (routes/models.ts),
    // so only the LLM and audio prefixes get their own listing here. The
    // create endpoint is registered for all three: sd-api's `POST /v1/models`
    // creates an image bundle and nothing modern claims that method+path.
    if (kind !== 'image') {
      app.get(
        prefix,
        { schema: { tags: ['compat'], summary: `List ${kind} models (sd-api compatible)` } },
        async () => ({ models: (await app.models.list(kind)).map(toLegacyBundle) }),
      );
    }

    app.post(
      prefix,
      {
        schema: {
          tags: ['compat'],
          summary: `Create a ${kind} model bundle (sd-api compatible)`,
          body: z.object({ id: z.string().min(1) }).passthrough(),
        },
      },
      async (req, reply) => {
        const body = req.body as { id: string; manifest?: unknown } & Record<string, unknown>;
        const manifest = manifestSchema.partial().parse(body.manifest ?? body);
        const bundle = await app.models.create(kind, body.id, manifest);
        return reply.code(201).send(toLegacyBundle(bundle));
      },
    );

    app.get(
      `${prefix}/:model`,
      {
        schema: {
          tags: ['compat'],
          summary: `Inspect a ${kind} model (sd-api compatible)`,
          params: z.object({ model: z.string() }),
        },
      },
      async (req) => toLegacyBundle(await app.models.get(kind, req.params.model)),
    );

    app.delete(
      `${prefix}/:model`,
      {
        schema: {
          tags: ['compat'],
          summary: `Delete a ${kind} model (sd-api compatible)`,
          params: z.object({ model: z.string() }),
        },
      },
      async (req, reply) => {
        await app.models.remove(kind, req.params.model);
        if (kind === 'audio') app.backends.scheduleRestart('audiocpp', 'audio model deleted');
        if (kind === 'llm') app.backends.scheduleRestart('llamacpp', 'llm model deleted');
        return reply.code(204).send(null);
      },
    );

    app.put(
      `${prefix}/:model/manifest`,
      {
        schema: {
          tags: ['compat'],
          summary: `Update a ${kind} model manifest (sd-api compatible)`,
          params: z.object({ model: z.string() }),
          body: manifestSchema,
        },
      },
      async (req) => {
        const bundle = await app.models.updateManifest(kind, req.params.model, req.body);
        if (kind === 'audio') app.backends.scheduleRestart('audiocpp', 'audio manifest changed');
        return toLegacyBundle(bundle);
      },
    );

    app.delete(
      `${prefix}/:model/:type/:name`,
      {
        schema: {
          tags: ['compat'],
          summary: `Delete a ${kind} model component (sd-api compatible)`,
          params: z.object({ model: z.string(), type: z.string(), name: z.string() }),
        },
      },
      async (req, reply) => {
        await app.models.removeComponent(
          kind,
          req.params.model,
          legacySlot(kind, req.params.type),
          req.params.name,
        );
        return reply.code(204).send(null);
      },
    );

    app.post(
      `${prefix}/download`,
      {
        schema: {
          tags: ['compat'],
          summary: `Queue a ${kind} component download (sd-api compatible)`,
          body: z.object({
            model: z.string().min(1),
            type: z.string(),
            url: z.string().url(),
            name: z.string().optional(),
          }),
        },
      },
      async (req, reply) => {
        const task = await app.downloads.enqueue({
          kind,
          bundle: req.body.model,
          slot: legacySlot(kind, req.body.type),
          url: req.body.url,
          name: req.body.name,
        });
        return reply.code(202).send(toLegacyTask(task));
      },
    );
  }

  // --- Download routes ------------------------------------------------------

  const downloadPrefixes: [prefix: string, kind: ModelKind][] = [
    ['/v1/llm-downloads', 'llm'],
    ['/v1/audio-downloads', 'audio'],
  ];

  for (const [prefix, kind] of downloadPrefixes) {
    app.get(
      prefix,
      { schema: { tags: ['compat'], summary: `List ${kind} downloads (sd-api compatible)` } },
      async () => ({ downloads: app.downloads.list({ kind }).map(toLegacyTask) }),
    );

    app.get(
      `${prefix}/:id`,
      {
        schema: {
          tags: ['compat'],
          summary: `One ${kind} download (sd-api compatible)`,
          params: z.object({ id: z.string() }),
        },
      },
      async (req) => {
        const task = app.downloads.get(req.params.id);
        if (!task) throw errors.downloadNotFound(req.params.id);
        return toLegacyTask(task);
      },
    );

    app.post(
      `${prefix}/:id/cancel`,
      {
        schema: {
          tags: ['compat'],
          summary: `Cancel a ${kind} download (sd-api compatible)`,
          params: z.object({ id: z.string() }),
        },
      },
      async (req) => toLegacyTask(app.downloads.cancel(req.params.id)),
    );

    app.post(
      `${prefix}/:id/retry`,
      {
        schema: {
          tags: ['compat'],
          summary: `Retry a ${kind} download (sd-api compatible)`,
          params: z.object({ id: z.string() }),
        },
      },
      async (req) => toLegacyTask(app.downloads.retry(req.params.id)),
    );

    app.delete(
      `${prefix}/:id`,
      {
        schema: {
          tags: ['compat'],
          summary: `Delete a ${kind} download (sd-api compatible)`,
          params: z.object({ id: z.string() }),
          querystring: z.object({ discard: z.coerce.boolean().default(false) }),
        },
      },
      async (req, reply) => {
        await app.downloads.remove(req.params.id, req.query.discard);
        return reply.code(204).send(null);
      },
    );

    app.get(
      `${prefix}/:id/stream`,
      {
        schema: {
          tags: ['compat'],
          summary: `Stream a ${kind} download (sd-api compatible)`,
          params: z.object({ id: z.string() }),
        },
      },
      async (req, reply) => {
        const stream = startSse(req, reply);
        const task = app.downloads.get(req.params.id);
        if (task) stream.send('progress', toLegacyTask(task));
        stream.onClose(
          app.downloads.subscribe(req.params.id, (event, updated) =>
            stream.send(event, toLegacyTask(updated)),
          ),
        );
      },
    );

    app.post(
      `${prefix}/resume`,
      { schema: { tags: ['compat'], summary: `Resume ${kind} downloads (sd-api compatible)` } },
      async () => ({ downloads: app.downloads.resumeAll().map(toLegacyTask) }),
    );
  }

  // --- Catalogue routes -----------------------------------------------------

  const cataloguePrefixes: [prefix: string, kind: ModelKind][] = [
    ['/v1/catalog', 'image'],
    ['/v1/llm-catalog', 'llm'],
    ['/v1/audio-catalog', 'audio'],
  ];

  for (const [prefix, kind] of cataloguePrefixes) {
    app.get(
      prefix,
      { schema: { tags: ['compat'], summary: `List ${kind} catalogue models (sd-api compatible)` } },
      async () => ({ models: await app.catalogue.list({ kind }) }),
    );

    app.get(
      `${prefix}/:id/files`,
      {
        schema: {
          tags: ['compat'],
          summary: `Catalogue model files (sd-api compatible)`,
          params: z.object({ id: z.string() }),
        },
      },
      async (req) => {
        const model = await app.catalogue.get(req.params.id);
        const components = await Promise.all(
          model.components.map(async (component) => ({
            ...component,
            files: await app.catalogue.componentFiles(model, component).catch(() => []),
          })),
        );
        return { components };
      },
    );
  }

  /**
   * Voice presets (sd-api: POST /v1/audio-models/:model/voice-presets).
   *
   * Merges into the manifest's existing presets rather than replacing the
   * whole manifest the way PUT .../manifest does, then restarts audio.cpp so
   * the preset is immediately selectable as `voice` on /v1/audio/speech.
   */
  app.post(
    '/v1/audio-models/:model/voice-presets',
    {
      schema: {
        tags: ['compat'],
        summary: 'Register a named voice preset on an audio model (sd-api compatible)',
        params: z.object({ model: z.string() }),
        body: z
          .object({ name: z.string().min(1), makeDefault: z.boolean().optional() })
          .passthrough(),
      },
    },
    async (req) => {
      const { name, makeDefault, ...preset } = req.body as {
        name: string;
        makeDefault?: boolean;
      } & Record<string, unknown>;

      const existing = await app.models.get('audio', req.params.model);
      const manifest = existing.manifest;
      if (!manifest?.family || !manifest?.task) {
        throw errors.invalidModel(
          `Audio model "${req.params.model}" has no model.json yet — set family/task first via PUT .../manifest`,
        );
      }

      const voicePresets = { ...(manifest.voicePresets ?? {}), [name]: preset };
      // First preset registered becomes the default, matching sd-api: a model
      // with exactly one voice should not need the caller to name it.
      const defaultVoicePreset =
        makeDefault || manifest.defaultVoicePreset === undefined ? name : manifest.defaultVoicePreset;

      const bundle = await app.models.updateManifest('audio', req.params.model, {
        ...manifest,
        voicePresets,
        defaultVoicePreset,
      });
      app.backends.scheduleRestart('audiocpp', 'voice preset registered');

      return {
        model: toLegacyBundle(bundle),
        voicePresets: Object.keys(voicePresets),
        defaultVoicePreset,
      };
    },
  );

  /**
   * Voice reference storage (sd-api: /v1/audio-voice-refs). The modern path is
   * /v1/audio/voice-refs; these are the same files under the old spelling,
   * since both resolve into the uploads directory.
   */
  app.get(
    '/v1/audio-voice-refs/:name',
    {
      schema: {
        tags: ['compat'],
        summary: 'Fetch a voice reference (sd-api compatible)',
        params: z.object({ name: z.string() }),
      },
    },
    async (req, reply) => {
      const path = safeResolve(app.paths.uploadsDir, req.params.name);
      try {
        await stat(path);
      } catch {
        throw errors.audioVoiceRefNotFound(req.params.name);
      }
      return reply.header('Content-Type', 'audio/wav').send(createReadStream(path));
    },
  );

  app.delete(
    '/v1/audio-voice-refs/:name',
    {
      schema: {
        tags: ['compat'],
        summary: 'Delete a voice reference (sd-api compatible)',
        params: z.object({ name: z.string() }),
      },
    },
    async (req, reply) => {
      await unlink(safeResolve(app.paths.uploadsDir, req.params.name)).catch(() => {});
      return reply.code(204).send(null);
    },
  );

  /**
   * sd-api's generic audio task runner, forwarded unchanged. Its request shape
   * is defined by audio.cpp rather than by us, so it is proxied rather than
   * modelled.
   */
  app.post(
    '/v1/audio/tasks/run',
    { schema: { tags: ['compat'], summary: 'Run an audio.cpp task (sd-api compatible)' } },
    async (req, reply) =>
      proxyToBackend(app.backends, req, reply, {
        backend: 'audiocpp',
        upstreamPath: '/v1/audio/tasks/run',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        timeoutMs: app.config.audiocppTimeoutMs,
      }),
  );
}
