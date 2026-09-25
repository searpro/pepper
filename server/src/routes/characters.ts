import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errors } from '../errors.js';
import { jobSchema } from '../schemas/generate.js';
import { DESIGNER_PROMPT, PORTRAIT_TEMPLATE, SHEET_TEMPLATE } from '../services/characters.js';

/**
 * Character Studio — see `services/characters.ts`.
 *
 * Characters are picked up by the other screens by id: the Image, Video and
 * Audio screens read a character here and fold its description, images and
 * voice into their own requests, so there is no character-specific generation
 * endpoint beyond the studio's own sheet, portrait and voice-preview jobs.
 */
export async function characterRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const voiceSchema = z
    .object({
      model: z.string().optional(),
      instructions: z.string().max(2000).optional(),
      voice: z.string().optional(),
      voice_ref: z.string().optional(),
      sample: z.string().optional(),
      sample_text: z.string().optional(),
    })
    .nullable();

  const editable = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    brief: z.string().max(4000).optional(),
    style: z.string().max(300).optional(),
    appearance: z.string().max(6000).optional(),
    personality: z.string().max(2000).optional(),
    voice: voiceSchema.optional(),
  });

  const idParams = z.object({ id: z.string() });

  app.get(
    '/v1/characters',
    { schema: { tags: ['characters'], summary: 'List characters, most recently changed first' } },
    async () => ({ characters: app.characters.list() }),
  );

  app.get(
    '/v1/characters/prompts',
    {
      schema: {
        tags: ['characters'],
        summary: 'The system prompt and sheet templates the studio uses',
      },
    },
    async () => ({ designer: DESIGNER_PROMPT, sheet: SHEET_TEMPLATE, portrait: PORTRAIT_TEMPLATE }),
  );

  app.post(
    '/v1/characters/design',
    {
      schema: {
        tags: ['characters'],
        summary: 'Expand a minimal prompt into a character design',
        description:
          'Runs the designer system prompt on an installed LLM (or `model`) and returns name, ' +
          'style, a detailed visual description, personality and a voice direction. `source` is ' +
          '`template` when no LLM was usable and the brief is returned as the description.',
        body: z.object({
          brief: z.string().min(1).max(4000),
          name: z.string().max(120).optional(),
          style: z.string().max(300).optional(),
          /** LLM bundle id, or "none" to skip the LLM. */
          model: z.string().optional(),
        }),
      },
    },
    async (req) => app.characters.design(req.body),
  );

  app.post(
    '/v1/characters',
    {
      schema: { tags: ['characters'], summary: 'Create a character', body: editable },
    },
    async (req, reply) => reply.code(201).send(app.characters.create(req.body)),
  );

  app.get(
    '/v1/characters/:id',
    { schema: { tags: ['characters'], summary: 'Get a character', params: idParams } },
    async (req) => {
      const character = app.characters.get(req.params.id);
      return {
        ...character,
        sheet_prompt: app.characters.sheetPrompt(character),
        portrait_prompt: app.characters.portraitPrompt(character, false),
      };
    },
  );

  app.patch(
    '/v1/characters/:id',
    {
      schema: {
        tags: ['characters'],
        summary: 'Update a character',
        params: idParams,
        body: editable.extend({ thumbnail: z.string().optional() }),
      },
    },
    async (req) => app.characters.update(req.params.id, req.body),
  );

  app.delete(
    '/v1/characters/:id',
    {
      schema: {
        tags: ['characters'],
        summary: 'Delete a character (its image files stay in uploads)',
        params: idParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      app.characters.remove(req.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/characters/:id/generate',
    {
      schema: {
        tags: ['characters'],
        summary: 'Queue a character sheet or portrait',
        description:
          'An ordinary image job whose output is attached to the character when it completes. ' +
          'Without `prompt`, the sheet or portrait template is filled from the character.',
        params: idParams,
        body: z.object({
          role: z.enum(['sheet', 'portrait']),
          model: z.string().min(1),
          prompt: z.string().max(8000).optional(),
          width: z.number().int().min(256).max(2048).multipleOf(16).optional(),
          height: z.number().int().min(256).max(2048).multipleOf(16).optional(),
          steps: z.number().int().min(1).max(200).optional(),
          cfg_scale: z.number().min(0).max(30).optional(),
          seed: z.number().int().min(-1).optional(),
          from_sheet: z.boolean().optional(),
        }),
        response: { 202: jobSchema },
      },
    },
    async (req, reply) => {
      const bundle = await app.models.find(req.body.model, ['image']);
      if (!bundle || bundle.mode !== 'image') throw errors.modelNotFound(req.body.model);
      const { from_sheet: fromSheet, ...rest } = req.body;
      return reply.code(202).send(app.characters.generateImage(req.params.id, { ...rest, fromSheet }));
    },
  );

  app.post(
    '/v1/characters/:id/images',
    {
      schema: {
        tags: ['characters'],
        summary: 'Attach an existing output or upload to a character',
        params: idParams,
        body: z.object({
          name: z.string().min(1),
          source: z.enum(['output', 'upload']).default('upload'),
          role: z.enum(['sheet', 'portrait', 'reference']).default('reference'),
        }),
      },
    },
    async (req) => app.characters.addImage(req.params.id, req.body),
  );

  app.delete(
    '/v1/characters/:id/images/:name',
    {
      schema: {
        tags: ['characters'],
        summary: 'Detach an image from a character',
        params: z.object({ id: z.string(), name: z.string() }),
      },
    },
    async (req) => app.characters.removeImage(req.params.id, req.params.name),
  );

  app.post(
    '/v1/characters/:id/voice/preview',
    {
      schema: {
        tags: ['characters'],
        summary: 'Queue a short clip in the character’s voice',
        params: idParams,
        body: z.object({ text: z.string().max(1000).optional() }).default({}),
        response: { 202: jobSchema },
      },
    },
    async (req, reply) => {
      const voice = app.characters.get(req.params.id).voice;
      if (voice?.model) {
        const bundle = await app.models.find(voice.model, ['audio']);
        if (!bundle) throw errors.modelNotFound(voice.model);
      }
      return reply.code(202).send(app.characters.previewVoice(req.params.id, req.body.text));
    },
  );
}
