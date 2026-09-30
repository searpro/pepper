import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '@pepper/core/errors.js';
import { contentType, parseRange } from '@pepper/core/routes/media.js';
import { ASPECTS, ASSET_KINDS, SHOT_KINDS } from '../projects/schema.js';
import type { ProjectService } from '../projects/service.js';

export interface ProjectRoutesOptions {
  projects: ProjectService;
}

const aspect = z.enum(ASPECTS);
const assetKind = z.enum(ASSET_KINDS);
const shotKind = z.enum(SHOT_KINDS);

const projectBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  aspect: aspect.optional(),
  fps: z.number().int().min(8).max(60).optional(),
  style: z.string().max(2000).optional(),
  lut: z.string().nullable().optional(),
  licenceMode: z.enum(['personal', 'commercial']).optional(),
  script: z.string().max(200_000).optional(),
});

const assetBody = z.object({
  kind: assetKind,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  images: z.array(z.string()).max(16).optional(),
  voice: z.object({ upload: z.string().optional(), description: z.string().optional() }).nullable().optional(),
  audio: z.string().nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});

const dialogueLine = z.object({
  asset_id: z.string().optional(),
  speaker: z.string().optional(),
  line: z.string().max(2000),
});

const shotBody = z.object({
  kind: shotKind.optional(),
  durationS: z.number().min(0.5).max(600).optional(),
  framing: z.string().max(500).optional(),
  camera: z.string().max(500).optional(),
  prompt: z.string().max(8000).optional(),
  dialogue: z.array(dialogueLine).max(40).optional(),
  sound: z.string().max(2000).optional(),
  assetIds: z.array(z.string()).max(16).optional(),
  keyframes: z.object({ first: z.string().optional(), last: z.string().optional() }).optional(),
  audioAssetId: z.string().nullable().optional(),
  recipeId: z.string().nullable().optional(),
  params: z.record(z.unknown()).optional(),
});

/** The plan `plan_project` sends; see `PlanInput` in projects/service.ts. */
export const planSchema = z.object({
  script: z.string().max(200_000).optional(),
  style: z.string().max(2000).optional(),
  replace: z.boolean().optional(),
  assets: z
    .array(
      z.object({
        ref: z.string().min(1),
        kind: assetKind,
        name: z.string().min(1),
        description: z.string().optional(),
        images: z.array(z.string()).optional(),
        audio: z.string().optional(),
        voice: z.object({ upload: z.string().optional(), description: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  scenes: z
    .array(
      z.object({
        title: z.string().optional(),
        notes: z.string().optional(),
        shots: z
          .array(
            z.object({
              kind: shotKind.optional(),
              duration_s: z.number().min(0.5).max(600).optional(),
              framing: z.string().optional(),
              camera: z.string().optional(),
              prompt: z.string().min(1),
              dialogue: z.array(z.object({ speaker: z.string(), line: z.string() })).optional(),
              sound: z.string().optional(),
              assets: z.array(z.string()).optional(),
              audio: z.string().optional(),
              recipe: z.string().optional(),
              params: z.record(z.unknown()).optional(),
            }),
          )
          .max(200),
      }),
    )
    .max(100),
});

export const renderSchema = z.object({
  shot_ids: z.array(z.string()).min(1).max(100),
  /** Recipe mode; the recipe's default (usually the draft) when omitted. */
  mode: z.string().optional(),
  /** Takes per shot. */
  count: z.number().int().min(1).max(8).optional(),
  seed: z.number().int().min(0).optional(),
  /** Re-render this take's seed, e.g. finishing a chosen draft. */
  from_take: z.string().optional(),
});

const cutItem = z.object({
  take_id: z.string(),
  in: z.number().min(0).optional(),
  out: z.number().min(0).optional(),
  transition: z.enum(['cut', 'fade']).optional(),
});

const cutBody = z.object({
  name: z.string().max(200).optional(),
  items: z.array(cutItem).max(500).optional(),
  music: z
    .object({ asset_id: z.string(), gain_db: z.number().min(-40).max(6).optional(), duck: z.boolean().optional() })
    .nullable()
    .optional(),
  subtitles: z.boolean().optional(),
  /** Snap cut points back to the music bed's beats (analyze it first). */
  beatSync: z.boolean().optional(),
});

const id = z.object({ id: z.string() });

/** Projects, assets, scenes, shots, takes and cuts (docs/PEPPER-PRO.md §8). */
export async function projectRoutes(fastify: FastifyInstance, options: ProjectRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { projects } = options;
  const tags = ['projects'];

  // --- Projects --------------------------------------------------------------

  app.get('/v1/projects', { schema: { tags, summary: 'List projects' } }, async () => ({ projects: projects.listProjects() }));

  app.post(
    '/v1/projects',
    { schema: { tags, summary: 'Create a project', body: projectBody } },
    async (req, reply) => reply.code(201).send(projects.createProject(req.body)),
  );

  app.get(
    '/v1/projects/:id',
    { schema: { tags, summary: 'A project with its assets, scenes, shots, takes and cuts', params: id } },
    async (req) => projects.getProject(req.params.id),
  );

  app.patch(
    '/v1/projects/:id',
    { schema: { tags, summary: 'Update a project', params: id, body: projectBody.partial() } },
    async (req) => projects.updateProject(req.params.id, req.body),
  );

  app.delete(
    '/v1/projects/:id',
    { schema: { tags, summary: 'Delete a project and everything in it', params: id } },
    async (req, reply) => {
      await projects.deleteProject(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/projects/:id/plan',
    {
      schema: {
        tags,
        summary: 'Apply a plan: assets, then scenes of shots',
        description:
          'One structured document instead of many calls. Asset `ref`s are names the plan uses to point ' +
          'at assets from shots and dialogue; existing assets can be named by id or name.',
        params: id,
        body: planSchema,
      },
    },
    async (req) => projects.plan(req.params.id, req.body),
  );

  // --- Assets ----------------------------------------------------------------

  app.get(
    '/v1/projects/:id/assets',
    { schema: { tags, summary: "A project's assets and the shared library", params: id } },
    async (req) => ({ assets: projects.listAssets(req.params.id) }),
  );

  app.post(
    '/v1/projects/:id/assets',
    { schema: { tags, summary: 'Add an asset to a project', params: id, body: assetBody } },
    async (req, reply) => reply.code(201).send(projects.createAsset(req.params.id, req.body)),
  );

  app.get('/v1/assets', { schema: { tags, summary: 'The shared asset library' } }, async () => ({ assets: projects.listAssets(null) }));

  app.post(
    '/v1/assets',
    { schema: { tags, summary: 'Add an asset to the shared library', body: assetBody } },
    async (req, reply) => reply.code(201).send(projects.createAsset(null, req.body)),
  );

  app.patch(
    '/v1/assets/:id',
    { schema: { tags, summary: 'Update an asset', params: id, body: assetBody.partial() } },
    async (req) => projects.updateAsset(req.params.id, req.body),
  );

  app.delete('/v1/assets/:id', { schema: { tags, summary: 'Delete an asset', params: id } }, async (req, reply) => {
    projects.deleteAsset(req.params.id);
    return reply.code(204).send();
  });

  // --- Scenes and shots ------------------------------------------------------

  app.post(
    '/v1/projects/:id/scenes',
    { schema: { tags, summary: 'Add a scene', params: id, body: z.object({ title: z.string().optional(), notes: z.string().optional() }) } },
    async (req, reply) => reply.code(201).send(projects.createScene(req.params.id, req.body)),
  );

  app.patch(
    '/v1/scenes/:id',
    { schema: { tags, summary: 'Update a scene', params: id, body: z.object({ title: z.string().optional(), notes: z.string().optional() }) } },
    async (req) => projects.updateScene(req.params.id, req.body),
  );

  app.delete('/v1/scenes/:id', { schema: { tags, summary: 'Delete a scene and its shots', params: id } }, async (req, reply) => {
    projects.deleteScene(req.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/v1/scenes/:id/shots',
    { schema: { tags, summary: 'Add a shot to a scene', params: id, body: shotBody } },
    async (req, reply) => reply.code(201).send(projects.createShot(req.params.id, req.body)),
  );

  app.patch(
    '/v1/shots/:id',
    {
      schema: {
        tags,
        summary: 'Update a shot, or move it',
        params: id,
        body: shotBody.extend({ sceneId: z.string().optional(), position: z.number().int().min(0).optional() }),
      },
    },
    async (req) => projects.updateShot(req.params.id, req.body),
  );

  app.delete('/v1/shots/:id', { schema: { tags, summary: 'Delete a shot and its takes', params: id } }, async (req, reply) => {
    projects.deleteShot(req.params.id);
    return reply.code(204).send();
  });

  app.get(
    '/v1/shots/:id/request',
    {
      schema: {
        tags,
        summary: 'The recipe request a shot would render as',
        description: 'The composed prompt and derived parameters, to read before spending a render.',
        params: id,
        querystring: z.object({ mode: z.string().optional() }),
      },
    },
    async (req) => projects.requestFor(req.params.id, req.query.mode),
  );

  app.post(
    '/v1/shots/render',
    {
      schema: {
        tags,
        summary: 'Render takes of shots',
        description:
          'Queues `count` takes per shot in `mode`, each with its own seed. `from_take` re-renders that ' +
          "take's seed, which is how a chosen draft is finished.",
        body: renderSchema,
      },
    },
    async (req, reply) =>
      reply.code(202).send({
        takes: (
          await projects.renderShots(req.body.shot_ids, {
            mode: req.body.mode,
            count: req.body.count,
            seed: req.body.seed,
            fromTake: req.body.from_take,
          })
        ).map((take) => projects.viewTake(take)),
      }),
  );

  // --- Takes -----------------------------------------------------------------

  app.get(
    '/v1/shots/:id/takes',
    { schema: { tags, summary: "A shot's takes, newest first", params: id } },
    async (req) => ({ takes: projects.listTakes(req.params.id) }),
  );

  app.patch(
    '/v1/takes/:id',
    {
      schema: {
        tags,
        summary: 'Score or annotate a take',
        params: id,
        body: z.object({ score: z.number().int().min(0).max(5).nullable().optional(), notes: z.string().max(2000).optional() }),
      },
    },
    async (req) => projects.updateTake(req.params.id, req.body),
  );

  app.post(
    '/v1/takes/:id/choose',
    { schema: { tags, summary: "Make a take its shot's chosen one", params: id } },
    async (req) => projects.chooseTake(req.params.id),
  );

  app.delete('/v1/takes/:id', { schema: { tags, summary: 'Delete a take (cancelling it if running)', params: id } }, async (req, reply) => {
    await projects.deleteTake(req.params.id);
    return reply.code(204).send();
  });

  // --- Cuts ------------------------------------------------------------------

  app.post(
    '/v1/projects/:id/cuts',
    {
      schema: {
        tags,
        summary: 'Create a cut',
        description: "Without `items`, the cut is every shot's chosen take in story order.",
        params: id,
        body: cutBody,
      },
    },
    async (req, reply) => reply.code(201).send(projects.createCut(req.params.id, req.body)),
  );

  app.patch(
    '/v1/cuts/:id',
    { schema: { tags, summary: 'Update a cut', params: id, body: cutBody } },
    async (req) => projects.updateCut(req.params.id, req.body),
  );

  app.delete('/v1/cuts/:id', { schema: { tags, summary: 'Delete a cut', params: id } }, async (req, reply) => {
    projects.deleteCut(req.params.id);
    return reply.code(204).send();
  });

  app.post(
    '/v1/cuts/:id/export',
    { schema: { tags, summary: 'Render a cut to a finished video (a render job)', params: id } },
    async (req, reply) => reply.code(202).send(projects.exportCut(req.params.id)),
  );

  // --- Files kept in a project ------------------------------------------------

  app.get(
    '/v1/projects/:id/files/:name',
    { schema: { tags, summary: 'A take or export kept in a project', params: z.object({ id: z.string(), name: z.string() }) } },
    async (req, reply) => {
      projects.requireProject(req.params.id);
      const path = projects.takeFile(req.params.id, req.params.name);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        throw errors.outputNotFound(req.params.name);
      }
      reply.header('Content-Type', contentType(req.params.name)).header('Accept-Ranges', 'bytes');
      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      if (range) {
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(createReadStream(path, range));
      }
      return reply.header('Content-Length', size).send(createReadStream(path));
    },
  );
}
