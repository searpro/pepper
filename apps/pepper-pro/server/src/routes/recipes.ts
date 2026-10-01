import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DownloadManager } from '@pepper/core/downloads/manager.js';
import type { StorageMonitor } from '@pepper/core/services/storage.js';
import type { ProConfig } from '../config.js';
import type { DownloadKind, DownloadSlot } from '../recipes/layout.js';
import type { Recipe } from '../recipes/schema.js';
import type { RecipeStatus, RecipeStore } from '../recipes/store.js';

export interface RecipeRoutesOptions {
  config: ProConfig;
  recipes: RecipeStore;
  downloads: DownloadManager<DownloadKind, DownloadSlot>;
  storage: StorageMonitor;
}

/** A recipe as the Recipes screen and the MCP tools see it: the definition, minus graph internals, plus its state here. */
export function recipeSummary(recipe: Recipe, status: RecipeStatus) {
  return {
    id: recipe.id,
    version: recipe.version,
    kind: recipe.kind,
    name: recipe.name,
    description: recipe.description,
    family: recipe.family,
    capabilities: recipe.capabilities,
    licence: recipe.licence,
    tiers: recipe.tiers,
    modes: Object.entries(recipe.modes).map(([id, mode]) => ({ id, label: mode.label, description: mode.description })),
    default_mode: recipe.default_mode,
    params: recipe.params,
    samples: recipe.samples,
    verified: recipe.verified,
    notes: recipe.notes,
    state: status.state,
    tier_verified: status.tierVerified,
    licence_block: status.licenceBlock,
    missing_bytes: status.missingBytes,
    install_bytes: status.installBytes,
    files: status.files.map((f) => ({
      id: f.file.id,
      label: f.file.label,
      folder: f.bundle,
      name: f.name,
      optional: f.file.optional,
      installed: f.installed,
      bytes: f.variant.bytes,
      url: f.url,
    })),
  };
}

/** Recipes (docs/PEPPER-PRO.md §6): what is available, what is installed, and installing it. */
export async function recipeRoutes(fastify: FastifyInstance, options: RecipeRoutesOptions): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { config, recipes, downloads, storage } = options;

  const summary = async (recipe: Recipe) =>
    recipeSummary(recipe, await recipes.status(recipe, config.tier, config.licenceMode));

  app.get(
    '/v1/recipes',
    {
      schema: {
        tags: ['recipes'],
        summary: 'Recipes with their install state on this tier',
        querystring: z.object({ kind: z.enum(['image', 'video', 'audio']).optional() }),
      },
    },
    async (req) => ({
      tier: config.tier,
      licence_mode: config.licenceMode,
      recipes: await Promise.all(
        recipes
          .list()
          .filter((r) => !req.query.kind || r.kind === req.query.kind)
          .map(summary),
      ),
      broken: recipes.broken,
    }),
  );

  const idParams = z.object({ id: z.string() });

  app.get(
    '/v1/recipes/:id',
    { schema: { tags: ['recipes'], summary: 'One recipe and its install state', params: idParams } },
    async (req) => summary(recipes.require(req.params.id)),
  );

  app.post(
    '/v1/recipes/:id/install',
    {
      schema: {
        tags: ['recipes'],
        summary: "Download a recipe's missing files for this tier",
        description:
          'Queues one download per missing file into its ComfyUI folder. Files already present ' +
          '(shared with another recipe) are not downloaded again. `optional` includes files only ' +
          'some modes use, such as a turbo LoRA.',
        params: idParams,
        body: z.object({ optional: z.boolean().default(true) }).default({}),
      },
    },
    async (req, reply) => {
      const recipe = recipes.require(req.params.id);
      const files = await recipes.resolveFiles(recipe, config.tier);
      const active = new Set(
        downloads.list({ status: ['queued', 'downloading'] }).map((d) => `${d.bundle}/${d.name}`),
      );
      const wanted = files.filter((f) => !f.installed && !(f.file.optional && !req.body.optional));
      // Refused whole, before anything is queued: each download checks its own
      // room when it starts, but a recipe half installed is no use, and a
      // full volume crashes the server's database.
      const bytes = wanted
        .filter((f) => !active.has(`${f.bundle}/${f.name}`))
        .reduce((sum, f) => sum + (f.variant.bytes ?? 0), 0);
      await storage.assertRoom(bytes, downloads.pendingBytes(), `${recipe.name}`);
      const tasks = [];
      for (const file of wanted) {
        tasks.push(
          await downloads.enqueue({
            kind: 'comfy',
            bundle: file.bundle,
            slot: 'file',
            url: file.url,
            name: file.name,
            expectedBytes: file.variant.bytes ?? undefined,
          }),
        );
      }
      return reply.code(202).send({ recipe: recipe.id, downloads: tasks });
    },
  );

  app.delete(
    '/v1/recipes/:id',
    {
      schema: {
        tags: ['recipes'],
        summary: "Delete a recipe's files, keeping any another installed recipe still uses",
        params: idParams,
      },
    },
    async (req) => {
      const recipe = recipes.require(req.params.id);
      const mine = await recipes.resolveFiles(recipe, config.tier);
      // Reference counting from disk: a file stays if any other recipe that
      // has anything installed resolves to the same folder and name.
      const kept = new Set<string>();
      for (const other of recipes.list()) {
        if (other.id === recipe.id) continue;
        const files = await recipes.resolveFiles(other, config.tier);
        if (!files.some((f) => f.installed)) continue;
        for (const f of files) kept.add(f.relPath);
      }
      const deleted: string[] = [];
      const shared: string[] = [];
      for (const file of mine) {
        const key = file.relPath;
        if (!file.installed) continue;
        if (kept.has(key)) {
          shared.push(key);
          continue;
        }
        await rm(file.path, { force: true });
        deleted.push(key);
      }
      return { recipe: recipe.id, deleted, kept: shared };
    },
  );

  app.post(
    '/v1/recipes/reload',
    { schema: { tags: ['recipes'], summary: 'Re-read the recipe directory (development)' } },
    async () => {
      await recipes.load();
      return { recipes: recipes.list().length, broken: recipes.broken };
    },
  );
}
