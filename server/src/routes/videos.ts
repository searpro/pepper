import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { errorResponseSchema } from '../schemas/generate.js';
import type { Job } from '../jobs/manager.js';

/**
 * OpenAI-shaped video generation.
 *
 * The requirement asks for the industry-standard shape where one exists, and
 * for video it does: OpenAI's `/v1/videos` is what current SDKs and tooling
 * speak. `/v1/jobs` stays exactly as it was — sd-api clients depend on it and
 * it carries knobs (samplers, flow shift, chunk sizing) that no standard
 * covers — so this is a second, additive surface over the same queue rather
 * than a replacement. Nothing here owns generation; it translates names.
 *
 * The mapping to the standard's vocabulary:
 *
 *   queued/running/completed/failed  ->  queued/in_progress/completed/failed
 *   `size` "1280x720"                ->  width/height
 *   `seconds`                        ->  video_frames, via the model's fps
 *   `input_reference`                ->  init_image  (an uploaded input name)
 *
 * `input_audio` is this API's own extension. OpenAI has no speech-conditioned
 * video parameter to copy, and inventing a differently-named one would only
 * mean two spellings of the same thing.
 */

/** OpenAI reports video jobs with its own status vocabulary. */
function videoStatus(status: Job['status']): string {
  if (status === 'running') return 'in_progress';
  if (status === 'cancelled') return 'failed';
  return status;
}

const videoObjectSchema = z.object({
  id: z.string(),
  object: z.literal('video'),
  model: z.string(),
  status: z.string(),
  progress: z.number(),
  created_at: z.number(),
  completed_at: z.number().optional(),
  seconds: z.number().optional(),
  size: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /** Where the finished file is served from. Not part of OpenAI's object. */
  url: z.string().optional(),
});

function toVideoObject(job: Job) {
  const params = job.params as Record<string, unknown>;
  const metadata = (job.result?.metadata ?? {}) as Record<string, unknown>;

  const width = params.width as number | undefined;
  const height = params.height as number | undefined;

  return {
    id: job.id,
    object: 'video' as const,
    model: String(params.model ?? ''),
    status: videoStatus(job.status),
    progress: job.progress,
    // Unix seconds is what the standard uses; the job table keeps ISO strings.
    created_at: Math.floor(new Date(job.createdAt).getTime() / 1000),
    completed_at: job.finishedAt
      ? Math.floor(new Date(job.finishedAt).getTime() / 1000)
      : undefined,
    seconds: (metadata.audio_duration_s as number | undefined) ?? undefined,
    size: width && height ? `${width}x${height}` : undefined,
    error: job.error,
    url: job.result?.video_url as string | undefined,
  };
}

/** "1280x720" -> width/height, rejecting anything that is not that shape. */
function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) throw errors.validation(`Invalid size "${size}". Expected "<width>x<height>".`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function videoRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const createSchema = z.object({
    model: z.string().min(1, 'model is required'),
    prompt: z.string().min(1, 'prompt is required'),
    /** Target duration. Converted to a frame count using the model's fps. */
    seconds: z.number().min(0.1).max(600).optional(),
    /** "<width>x<height>". */
    size: z.string().optional(),
    /** Name of an uploaded image, from POST /v1/inputs. */
    input_reference: z.string().optional(),
    /**
     * Name of an uploaded audio file, from POST /v1/inputs. Extension: this is
     * what makes the request speech-to-video.
     */
    input_audio: z.string().optional(),
    seed: z.number().int().min(-1).optional(),
  });

  app.post(
    '/v1/videos',
    {
      schema: {
        tags: ['videos'],
        summary: 'Create a video (OpenAI-compatible)',
        description:
          'Standard-shaped entry point over the same queue as POST /v1/jobs. Poll GET ' +
          '/v1/videos/:id, or stream progress from GET /v1/jobs/:id/stream. Pass ' +
          '`input_audio` (an uploaded file name) for speech-to-video.',
        body: createSchema,
        response: { 200: videoObjectSchema, 400: errorResponseSchema },
      },
    },
    async (req) => {
      const bundle = await app.models.find(req.body.model, ['video', 'image']);
      if (!bundle) throw errors.modelNotFound(req.body.model);
      if (bundle.mode !== 'video') {
        throw errors.validation(`Model "${req.body.model}" is not a video model`);
      }
      if (req.body.input_audio && !bundle.capabilities.includes('s2v')) {
        throw errors.validation(
          `Model "${req.body.model}" does not support speech-to-video. Choose a model ` +
            'whose capabilities include "s2v".',
        );
      }

      const params: Record<string, unknown> = {
        model: req.body.model,
        prompt: req.body.prompt,
      };
      if (req.body.size) Object.assign(params, parseSize(req.body.size));
      if (req.body.input_reference) params.init_image = req.body.input_reference;
      if (req.body.input_audio) params.audio = req.body.input_audio;
      if (req.body.seed !== undefined && req.body.seed >= 0) params.seed = req.body.seed;

      // `seconds` is the standard's unit; sd-cli counts frames. Converting
      // here rather than pushing frames into the public shape is the whole
      // point of having this surface. With speech the audio already fixes the
      // duration, so an explicit `seconds` would only contradict it.
      if (req.body.seconds !== undefined && !req.body.input_audio) {
        const fps = bundle.manifest?.defaults?.fps ?? 16;
        params.video_frames = Math.max(1, Math.round(req.body.seconds * fps));
        params.fps = fps;
      }

      return toVideoObject(app.jobs.create('video', params));
    },
  );

  const idParam = z.object({ id: z.string() });

  app.get(
    '/v1/videos',
    {
      schema: {
        tags: ['videos'],
        summary: 'List video jobs (OpenAI-compatible)',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }),
        response: { 200: z.object({ object: z.literal('list'), data: z.array(videoObjectSchema) }) },
      },
    },
    async (req) => ({
      object: 'list' as const,
      data: app.jobs.list({ kind: 'video', limit: req.query.limit }).map(toVideoObject),
    }),
  );

  app.get(
    '/v1/videos/:id',
    {
      schema: {
        tags: ['videos'],
        summary: 'Retrieve a video (OpenAI-compatible)',
        params: idParam,
        response: { 200: videoObjectSchema, 404: errorResponseSchema },
      },
    },
    async (req) => toVideoObject(app.jobs.require(req.params.id)),
  );

  app.delete(
    '/v1/videos/:id',
    {
      schema: {
        tags: ['videos'],
        summary: 'Delete a video job (OpenAI-compatible)',
        params: idParam,
        response: { 200: z.object({ id: z.string(), object: z.literal('video.deleted'), deleted: z.literal(true) }) },
      },
    },
    async (req) => {
      app.jobs.remove(req.params.id);
      return { id: req.params.id, object: 'video.deleted' as const, deleted: true as const };
    },
  );

  app.get(
    '/v1/videos/:id/content',
    {
      schema: {
        tags: ['videos'],
        summary: 'Download the rendered video (OpenAI-compatible)',
        params: idParam,
        response: { 409: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      const job = app.jobs.require(req.params.id);
      if (job.status !== 'completed') {
        throw errors.jobConflict(`Video ${req.params.id} is ${videoStatus(job.status)}`);
      }
      const url = job.result?.video_url as string | undefined;
      if (!url) throw errors.outputNotFound(req.params.id);
      // Redirecting rather than re-streaming keeps one implementation of range
      // requests, caching and content types — the one in /v1/outputs.
      return reply.redirect(url, 302);
    },
  );
}
