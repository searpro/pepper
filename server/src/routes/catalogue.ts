import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { parseSlot, type ModelManifest } from '../models/bundle.js';
import { MODEL_KINDS } from '../paths.js';

/**
 * The remote model catalogue (requirement 7) and one-click installs from it.
 */
export async function catalogueRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/catalogue',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'List catalogue models',
        querystring: z.object({
          kind: z.enum(MODEL_KINDS).optional(),
          search: z.string().optional(),
        }),
        response: {
          200: z.object({
            models: z.array(z.unknown()),
            state: z.unknown(),
          }),
        },
      },
    },
    async (req) => ({
      models: await app.catalogue.list({ kind: req.query.kind, search: req.query.search }),
      state: app.catalogue.state(),
    }),
  );

  app.post(
    '/v1/catalogue/refresh',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Refetch the remote catalogue now',
        response: { 200: z.unknown() },
      },
    },
    async () => {
      await app.catalogue.ensureLoaded(true);
      return app.catalogue.state();
    },
  );

  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/catalogue/:id',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'One catalogue model',
        params: idParam,
        response: { 200: z.unknown() },
      },
    },
    async (req) => app.catalogue.get(req.params.id),
  );

  /**
   * The live file listing for a model's components. Separate from the
   * catalogue entry itself because quantizations are uploaded to HuggingFace
   * continuously; baking them into the catalogue would make every new quant a
   * catalogue edit.
   */
  app.get(
    '/v1/catalogue/:id/files',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Downloadable files for each component of a catalogue model',
        params: idParam,
        response: { 200: z.object({ components: z.array(z.unknown()) }) },
      },
    },
    async (req) => {
      const model = await app.catalogue.get(req.params.id);
      const components = await Promise.all(
        model.components.map(async (component) => {
          try {
            return {
              ...component,
              files: await app.catalogue.componentFiles(model, component),
            };
          } catch (err) {
            // One unreachable or gated repo should not blank the whole
            // picker — the user can still install the components that are
            // listable, and sees why this one is not.
            return { ...component, files: [], error: (err as Error).message };
          }
        }),
      );
      return { components };
    },
  );

  /**
   * Install a catalogue model: write the manifest, then queue one download per
   * chosen component. The manifest is written *first* and deliberately: it
   * carries the audio `family`/`task` and the image `loadMode`, without which
   * a fully-downloaded bundle would still be unusable — and a user who has to
   * hand-author `model.json` after a one-click install has not had a one-click
   * install.
   */
  app.post(
    '/v1/catalogue/:id/install',
    {
      schema: {
        tags: ['catalogue'],
        summary: 'Install a catalogue model',
        params: idParam,
        body: z.object({
          /** Bundle directory name. Defaults to the catalogue id. */
          bundle: z.string().optional(),
          /** Chosen file per component, keyed by component slot+label. */
          selections: z
            .array(
              z.object({
                slot: z.string(),
                url: z.string().url(),
                name: z.string().optional(),
              }),
            )
            .min(1),
        }),
        response: { 202: z.unknown() },
      },
    },
    async (req, reply) => {
      const model = await app.catalogue.get(req.params.id);
      const bundleId = req.body.bundle ?? model.id;

      const manifest: ModelManifest = {
        name: model.name,
        kind: model.kind,
        load: model.loadMode,
        mode: model.mode,
        defaults: model.defaults as ModelManifest['defaults'],
        extra_args: model.extraArgs,
        capabilities: model.capabilities,
        s2v: model.s2v as ModelManifest['s2v'],
        family: model.family,
        task: model.task,
        audio_mode: model.audioMode,
        source: { catalogueId: model.id },
      };

      await app.models.create(model.kind, bundleId, manifest);

      const tasks = [];
      for (const selection of req.body.selections) {
        tasks.push(
          await app.downloads.enqueue({
            kind: model.kind,
            bundle: bundleId,
            slot: parseSlot(selection.slot),
            url: selection.url,
            name: selection.name,
          }),
        );
      }

      return reply.code(202).send({ bundle: bundleId, kind: model.kind, downloads: tasks });
    },
  );
}
