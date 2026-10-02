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

  /**
   * A recipe's installed files and, for each, the other recipes that still
   * use it. Reference counting from disk: another recipe uses a file if it
   * resolves to the same folder and name and is in use, meaning it has an
   * installed file of its own, not just ones it shares with this recipe.
   * Otherwise shared files would keep each other alive (H3's text encoder and
   * VAEs survived deleting h3-video because h3-reference "had files
   * installed", which were those same files).
   */
  const deletePlan = async (recipe: Recipe) => {
    const mine = await recipes.resolveFiles(recipe, config.tier);
    const mineKeys = new Set(mine.map((f) => f.relPath));
    const users = new Map<string, string[]>();
    for (const other of recipes.list()) {
      if (other.id === recipe.id) continue;
      const files = await recipes.resolveFiles(other, config.tier);
      if (!files.some((f) => f.installed && !mineKeys.has(f.relPath))) continue;
      for (const f of files) {
        if (mineKeys.has(f.relPath)) users.set(f.relPath, [...(users.get(f.relPath) ?? []), other.id]);
      }
    }
    return mine
      .filter((f) => f.installed)
      .map((f) => ({ file: f, path: f.relPath, label: f.file.label, bytes: f.size ?? 0, shared_with: users.get(f.relPath) ?? [] }));
  };

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
      // For the storage indicator: room left, and what queued downloads will still take of it.
      storage: await storage.usage(),
      downloading_bytes: downloads.pendingBytes(),
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

  app.get(
    '/v1/recipes/:id/delete-plan',
    {
      schema: {
        tags: ['recipes'],
        summary: "What deleting a recipe's files would remove, and which files other recipes share",
        description:
          'Each installed file with its size and `shared_with`, the installed recipes that use it too. ' +
          '`own_bytes` is freed whatever is chosen; `shared_bytes` only with `shared=delete`.',
        params: idParams,
      },
    },
    async (req) => {
      const plan = await deletePlan(recipes.require(req.params.id));
      return {
        recipe: req.params.id,
        files: plan.map(({ file: _file, ...rest }) => rest),
        own_bytes: plan.filter((f) => !f.shared_with.length).reduce((sum, f) => sum + f.bytes, 0),
        shared_bytes: plan.filter((f) => f.shared_with.length).reduce((sum, f) => sum + f.bytes, 0),
      };
    },
  );

  app.delete(
    '/v1/recipes/:id',
    {
      schema: {
        tags: ['recipes'],
        summary: "Delete a recipe's files",
        description:
          'Files other installed recipes use are kept unless `shared=delete`, which removes them too ' +
          'and leaves those recipes partly installed (`affected`). GET …/delete-plan shows the choice first.',
        params: idParams,
        querystring: z.object({ shared: z.enum(['keep', 'delete']).default('keep') }),
      },
    },
    async (req) => {
      const recipe = recipes.require(req.params.id);
      const plan = await deletePlan(recipe);
      const deleted: string[] = [];
      const kept: string[] = [];
      const affected = new Set<string>();
      let freed = 0;
      for (const entry of plan) {
        if (entry.shared_with.length && req.query.shared === 'keep') {
          kept.push(entry.path);
          continue;
        }
        await rm(entry.file.path, { force: true });
        deleted.push(entry.path);
        freed += entry.bytes;
        for (const id of entry.shared_with) affected.add(id);
      }
      storage.invalidate();
      return { recipe: recipe.id, deleted, kept, freed_bytes: freed, affected: [...affected] };
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
