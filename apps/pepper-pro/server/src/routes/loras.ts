import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LORA_BASES } from '../loras/bases.js';
import type { LoraService } from '../loras/service.js';
import type { RecipeStore } from '../recipes/store.js';

export interface LoraRoutesOptions {
  loras: LoraService;
  recipes: RecipeStore;
}

const editable = {
  name: z.string().trim().min(1).max(120).optional(),
  base: z.string().optional().describe('A base id from GET /v1/loras (`bases`): the recipes the LoRA fits.'),
  trigger_words: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  strength: z.number().min(-4).max(4).optional().describe('The weight it is applied at unless a request gives one; 1 is as trained.'),
  description: z.string().max(4000).optional(),
};

/**
 * The LoRA library: LoRAs from HuggingFace, Civitai or any link, kept once
 * and usable with every recipe on their base model (`src/loras/`).
 */
export async function loraRoutes(fastify: FastifyInstance, options: LoraRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { loras, recipes } = options;
  const idParams = z.object({ id: z.string() });

  app.get(
    '/v1/loras',
    {
      schema: {
        tags: ['loras'],
        summary: 'The LoRA library, and the base models LoRAs can be for',
        description:
          'Each LoRA with its state (installed, queued, downloading, failed, missing) and the installed recipes it ' +
          'fits. `bases` lists every base model with the recipes built on it.',
      },
    },
    async () => ({
      loras: await loras.list(),
      bases: LORA_BASES.map((base) => ({
        id: base.id,
        label: base.label,
        recipes: recipes
          .list()
          .filter((recipe) => recipe.lora_base === base.id)
          .map((recipe) => recipe.id),
      })),
    }),
  );

  app.post(
    '/v1/loras/lookup',
    {
      schema: {
        tags: ['loras'],
        summary: 'What a link to a LoRA is, without adding it',
        description:
          'Reads a Civitai page or download link, a HuggingFace repository or file, or any link to a .safetensors ' +
          'file: the file it downloads, its size, trigger words and the base model it seems to be for. A repository ' +
          'with several files lists them in `choices`; pass one back as `file`. `existing` names a library entry ' +
          'with the same file.',
        body: z.object({ url: z.string().url(), file: z.string().optional() }),
      },
    },
    async (req) => loras.lookup(req.body.url, req.body.file),
  );

  app.post(
    '/v1/loras',
    {
      schema: {
        tags: ['loras'],
        summary: 'Add a LoRA to the library and download it',
        description:
          'Looks the link up as /v1/loras/lookup does, then queues the download into models/loras/library. ' +
          'Fields given override what the source says; `base` is required when the source does not make it clear.',
        body: z.object({ url: z.string().url(), file: z.string().optional(), ...editable }),
      },
    },
    async (req, reply) => reply.code(202).send(await loras.add(req.body)),
  );

  app.get(
    '/v1/loras/:id',
    { schema: { tags: ['loras'], summary: 'One LoRA', params: idParams } },
    async (req) => loras.get(req.params.id),
  );

  app.patch(
    '/v1/loras/:id',
    {
      schema: {
        tags: ['loras'],
        summary: "Change a LoRA's name, base, trigger words, default strength or notes",
        params: idParams,
        body: z.object(editable),
      },
    },
    async (req) => {
      const { trigger_words, ...rest } = req.body;
      return loras.update(req.params.id, { ...rest, triggerWords: trigger_words });
    },
  );

  app.post(
    '/v1/loras/:id/retry',
    { schema: { tags: ['loras'], summary: "Download a LoRA's file again after a failure", params: idParams } },
    async (req, reply) => reply.code(202).send(await loras.retry(req.params.id)),
  );

  app.delete(
    '/v1/loras/:id',
    { schema: { tags: ['loras'], summary: 'Remove a LoRA and its file', params: idParams } },
    async (req, reply) => {
      await loras.remove(req.params.id);
      return reply.code(204).send();
    },
  );
}
