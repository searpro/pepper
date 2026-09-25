import { createReadStream } from 'node:fs';
import { copyFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { safeResolve } from '../paths.js';
import { listFiles, uniqueOutputName } from '../util/files.js';

/**
 * Outputs and uploads — what the UI's Media page is built from (requirement
 * 10: "Dedicated Media page for consolidated view of generations
 * audio/video/image" and "Dedicated Tab in media page for viewing uploads").
 *
 * sd-api could serve an output by name but could not list them, so a client
 * that lost a job id lost the file. Listing is what makes a media library
 * possible, and it comes from scanning the directory rather than from the job
 * table — outputs outlive their jobs, and a pruned job should not hide a file
 * that is still on disk.
 */

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTS = ['.webm', '.mp4', '.avi'];
const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.ogg'];

function mediaKind(name: string): 'image' | 'video' | 'audio' | 'other' {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  return 'other';
}

function contentType(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export async function mediaRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/v1/outputs',
    {
      schema: {
        tags: ['media'],
        summary: 'List generated outputs',
        querystring: z.object({
          kind: z.enum(['image', 'video', 'audio', 'other']).optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
        response: { 200: z.object({ outputs: z.array(z.unknown()) }) },
      },
    },
    async (req) => {
      const files = await listFiles(app.paths.outputDir);
      const outputs = files
        .map((file) => ({
          name: file.name,
          kind: mediaKind(file.name),
          size: file.size,
          modified: new Date(file.modified).toISOString(),
          url: `/v1/outputs/${encodeURIComponent(file.name)}`,
        }))
        .filter((output) => !req.query.kind || output.kind === req.query.kind)
        .sort((a, b) => b.modified.localeCompare(a.modified))
        .slice(0, req.query.limit);
      return { outputs };
    },
  );

  app.get(
    '/v1/outputs/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Fetch a generated output',
        params: z.object({ name: z.string() }),
      },
    },
    async (req, reply) => {
      const path = safeResolve(app.paths.outputDir, req.params.name);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        throw errors.outputNotFound(req.params.name);
      }
      return reply
        .header('Content-Type', contentType(req.params.name))
        .header('Content-Length', size)
        // Outputs are immutable and uniquely named, so a client that has one
        // never needs to ask again.
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(createReadStream(path));
    },
  );

  app.get(
    '/v1/outputs/:name/info',
    {
      schema: {
        tags: ['media'],
        summary: 'How an output was made: its job, parameters and result metadata',
        description:
          'Looks up the completed job that wrote this file. `job` is null when the file ' +
          'predates the job table or its job has been pruned.',
        params: z.object({ name: z.string() }),
      },
    },
    async (req) => {
      const path = safeResolve(app.paths.outputDir, req.params.name);
      let file;
      try {
        file = await stat(path);
      } catch {
        throw errors.outputNotFound(req.params.name);
      }
      const job = app.jobs.findByOutput(req.params.name);
      return {
        name: req.params.name,
        kind: mediaKind(req.params.name),
        size: file.size,
        modified: new Date(file.mtimeMs).toISOString(),
        url: `/v1/outputs/${encodeURIComponent(req.params.name)}`,
        job: job
          ? {
              id: job.id,
              params: job.params,
              metadata: (job.result?.metadata as Record<string, unknown> | undefined) ?? null,
              createdAt: job.createdAt,
              finishedAt: job.finishedAt,
            }
          : null,
      };
    },
  );

  app.get(
    '/v1/upscalers',
    {
      schema: {
        tags: ['media'],
        summary: 'Installed upscaler checkpoints, the scales they make available, and the catalogue',
      },
    },
    async () => {
      const models = await app.upscaler.listModels();
      const [x2, x4] = await Promise.all([
        app.upscaler.defaultModel(2),
        app.upscaler.defaultModel(4),
      ]);
      return {
        dir: app.upscaler.dir,
        models: models.map(({ path: _path, ...model }) => model),
        scales: await app.upscaler.availableScales(),
        preferences: app.upscaler.preferences(),
        defaults: { 2: x2?.name ?? null, 4: x4?.name ?? null },
        pythonReady: await app.pythonVideo.runtimeInstalled(),
        catalogue: await app.upscaler.catalogue(),
      };
    },
  );

  app.put(
    '/v1/upscalers/preferences',
    {
      schema: {
        tags: ['media'],
        summary: 'Set the upscaler engine and the default checkpoint per scale',
        body: z.object({
          engine: z.enum(['auto', 'python', 'sdcpp']).optional(),
          default_x2: z.string().nullable().optional(),
          default_x4: z.string().nullable().optional(),
        }),
      },
    },
    async (req) => app.upscaler.setPreferences(req.body),
  );

  app.post(
    '/v1/upscalers/install',
    {
      schema: {
        tags: ['media'],
        summary: 'Download an upscaler from the curated catalogue',
        description: 'Resolves once the checkpoint is on disk; the files are 5–140 MB.',
        body: z.object({ id: z.string().min(1) }),
      },
    },
    async (req) => {
      await app.upscaler.install(req.body.id);
      return { ok: true };
    },
  );

  app.delete(
    '/v1/upscalers/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Delete an installed upscaler checkpoint',
        params: z.object({ name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await app.upscaler.remove(req.params.name);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/v1/outputs/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Delete a generated output',
        params: z.object({ name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await unlink(safeResolve(app.paths.outputDir, req.params.name)).catch(() => {});
      return reply.code(204).send(null);
    },
  );

  // --- Uploads --------------------------------------------------------------

  app.post(
    '/v1/inputs',
    {
      schema: {
        tags: ['media'],
        summary: 'Upload an input file (init image, mask, reference image, voice reference)',
        consumes: ['multipart/form-data'],
        response: { 201: z.unknown() },
      },
    },
    async (req, reply) => {
      // sd-api accepted any number of files per request and answered with an
      // `inputs` array; clients index it (`inputs[0].name`) rather than reading
      // top-level keys. Returning only the flat object broke every one of them,
      // so the array is the contract and the first entry's fields are mirrored
      // at the top level for anything written against this rewrite.
      const uploaded: Array<Record<string, unknown>> = [];

      for await (const file of req.files()) {
        const ext = extname(file.filename || '').toLowerCase() || '.bin';
        // The client's filename is never used as the stored name: it is
        // attacker-controlled, may collide with an existing upload, and would
        // let one request overwrite another's reference image.
        const name = uniqueOutputName(ext.replace(/^\./, ''), 'upload');
        const path = safeResolve(app.paths.uploadsDir, name);

        await writeFile(path, await file.toBuffer());
        const size = (await stat(path)).size;

        uploaded.push({
          name,
          originalName: file.filename,
          kind: mediaKind(name),
          size,
          url: `/v1/inputs/${encodeURIComponent(name)}`,
        });
      }

      if (uploaded.length === 0) throw errors.validation('Expected a multipart file upload');

      return reply.code(201).send({ ...uploaded[0], inputs: uploaded });
    },
  );

  /**
   * Reuse a generated image as an input. It is copied rather than referenced:
   * outputs are swept by the retention timer, and an edit queued against one
   * should not fail because the source aged out while it waited.
   */
  app.post(
    '/v1/inputs/from-output',
    {
      schema: {
        tags: ['media'],
        summary: 'Copy a generated output into uploads, for use as an init or reference image',
        body: z.object({ name: z.string().min(1) }),
        response: { 201: z.unknown() },
      },
    },
    async (req, reply) => {
      const from = safeResolve(app.paths.outputDir, req.body.name);
      try {
        await stat(from);
      } catch {
        throw errors.outputNotFound(req.body.name);
      }
      const ext = extname(req.body.name).toLowerCase() || '.png';
      const name = uniqueOutputName(ext.replace(/^\./, ''), 'upload');
      const path = safeResolve(app.paths.uploadsDir, name);
      await copyFile(from, path);
      return reply.code(201).send({
        name,
        originalName: req.body.name,
        kind: mediaKind(name),
        size: (await stat(path)).size,
        url: `/v1/inputs/${encodeURIComponent(name)}`,
      });
    },
  );

  app.get(
    '/v1/inputs',
    {
      schema: {
        tags: ['media'],
        summary: 'List uploads',
        response: { 200: z.object({ uploads: z.array(z.unknown()) }) },
      },
    },
    async () => {
      const files = await listFiles(app.paths.uploadsDir);
      return {
        uploads: files
          .map((file) => ({
            name: file.name,
            kind: mediaKind(file.name),
            size: file.size,
            modified: new Date(file.modified).toISOString(),
            url: `/v1/inputs/${encodeURIComponent(file.name)}`,
          }))
          .sort((a, b) => b.modified.localeCompare(a.modified)),
      };
    },
  );

  app.get(
    '/v1/inputs/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Fetch an uploaded file',
        params: z.object({ name: z.string() }),
      },
    },
    async (req, reply) => {
      const path = safeResolve(app.paths.uploadsDir, req.params.name);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        throw errors.inputNotFound(req.params.name);
      }
      return reply
        .header('Content-Type', contentType(req.params.name))
        .header('Content-Length', size)
        .send(createReadStream(path));
    },
  );

  app.delete(
    '/v1/inputs/:name',
    {
      schema: {
        tags: ['media'],
        summary: 'Delete an upload',
        params: z.object({ name: z.string() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await unlink(safeResolve(app.paths.uploadsDir, req.params.name)).catch(() => {});
      return reply.code(204).send(null);
    },
  );
}
