import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { proErrors } from '../errors.js';
import { safeResolve, safeResolveNested } from '@pepper/core/paths.js';
import type { Prompt } from '../comfy/client.js';
import type { LicenceMode, Tier } from '../config.js';
import type { ProPaths } from '../paths.js';
import { recipeSchema, type FileVariant, type Licence, type Recipe, type RecipeFile } from './schema.js';

/**
 * The recipes this build ships (`recipes/<id>/recipe.json` plus its
 * workflows), read once at startup, and what is installed of each.
 *
 * Recipes come with the image rather than from a remote catalogue: a recipe
 * pins custom node packs, and node packs are built into the image, so a new
 * recipe is an image change either way. Install state is read from disk
 * every time — never stored — per "anything describing files on disk is
 * read from disk" (docs/ARCHITECTURE.md).
 */

export interface ResolvedFile {
  file: RecipeFile;
  variant: FileVariant;
  /** Name on disk inside its ComfyUI folder. */
  name: string;
  /** The folder, plus the variant's `dir` when it has one: the download bundle. */
  bundle: string;
  /** `bundle/name`, which is how a file is named in messages and sharing checks. */
  relPath: string;
  path: string;
  url: string;
  installed: boolean;
  /** Bytes on disk, when installed. */
  size?: number;
}

export type InstallState = 'installed' | 'partial' | 'missing';

export interface RecipeStatus {
  state: InstallState;
  files: ResolvedFile[];
  /** Bytes still to download for the required files. */
  missingBytes: number;
  /** Whether this recipe has been checked on the configured tier. */
  tierVerified: boolean;
  /** Why the recipe cannot be used under the given licence mode, if it cannot. */
  licenceBlock?: string;
}

export function variantUrl(variant: FileVariant): string {
  if (variant.url) return variant.url;
  const path = variant.path!.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${variant.repo}/resolve/${encodeURIComponent(variant.revision)}/${path}`;
}

export function variantName(variant: FileVariant): string {
  if (variant.name) return variant.name;
  return decodeURIComponent(basename(variant.path ?? new URL(variant.url!).pathname));
}

/** The variant of a file for a tier: one listing the tier, else one listing none. */
export function variantFor(file: RecipeFile, tier: Tier): FileVariant {
  return (
    file.variants.find((variant) => variant.tiers?.includes(tier)) ??
    file.variants.find((variant) => !variant.tiers) ??
    file.variants[0]
  );
}

/** Why a licence rules a recipe out for a licence mode, or undefined when it does not. */
export function licenceBlock(licence: Licence, mode: LicenceMode): string | undefined {
  if (mode === 'commercial' && licence.commercial === 'no') {
    return `${licence.name} does not allow commercial use`;
  }
  return undefined;
}

export class RecipeStore {
  private readonly recipes = new Map<string, Recipe>();
  private readonly workflows = new Map<string, Prompt>();
  /** Recipes that failed to load, with why: reported, never fatal. */
  readonly broken: { id: string; error: string }[] = [];

  constructor(
    private readonly dir: string,
    private readonly paths: ProPaths,
    private readonly log: FastifyBaseLogger,
  ) {}

  async load(): Promise<void> {
    this.recipes.clear();
    this.workflows.clear();
    this.broken.length = 0;
    let entries: string[] = [];
    try {
      entries = (await readdir(this.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      this.log.warn({ dir: this.dir }, 'no recipes directory');
      return;
    }
    for (const id of entries.sort()) {
      try {
        const recipe = recipeSchema.parse(JSON.parse(await readFile(join(this.dir, id, 'recipe.json'), 'utf8')));
        if (recipe.id !== id) throw new Error(`recipe.json says id "${recipe.id}" but lives in "${id}/"`);
        for (const [name, workflow] of Object.entries(recipe.workflows)) {
          const prompt = JSON.parse(await readFile(safeResolve(join(this.dir, id), workflow.file), 'utf8')) as Prompt;
          this.workflows.set(`${id}/${name}`, prompt);
        }
        this.recipes.set(id, recipe);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.broken.push({ id, error });
        this.log.error({ recipe: id, err: error }, 'recipe failed to load');
      }
    }
    this.log.info({ recipes: this.recipes.size, broken: this.broken.length }, 'recipes loaded');
  }

  list(): Recipe[] {
    return [...this.recipes.values()];
  }

  get(id: string): Recipe | undefined {
    return this.recipes.get(id);
  }

  require(id: string): Recipe {
    const recipe = this.recipes.get(id);
    if (!recipe) throw proErrors.recipeNotFound(id);
    return recipe;
  }

  /** A workflow's prompt. Callers must clone before changing it. */
  workflow(recipe: Recipe, name: string): Prompt {
    const prompt = this.workflows.get(`${recipe.id}/${name}`);
    if (!prompt) throw proErrors.recipeNotFound(`${recipe.id} (workflow "${name}")`);
    return prompt;
  }

  folderPath(folder: string): string {
    return join(this.paths.modelsDir, folder);
  }

  async resolveFiles(recipe: Recipe, tier: Tier): Promise<ResolvedFile[]> {
    return Promise.all(
      recipe.files.map(async (file) => {
        const variant = variantFor(file, tier);
        const name = variantName(variant);
        const dir = variant.dir ? variant.dir.split('/') : [];
        const path = safeResolveNested(this.folderPath(file.folder), ...dir, name);
        const bundle = [file.folder, ...dir].join('/');
        let size: number | undefined;
        try {
          size = (await stat(path)).size;
        } catch {
          size = undefined;
        }
        return { file, variant, name, bundle, relPath: `${bundle}/${name}`, path, url: variantUrl(variant), installed: size !== undefined, size };
      }),
    );
  }

  async status(recipe: Recipe, tier: Tier, licenceMode: LicenceMode): Promise<RecipeStatus> {
    const files = await this.resolveFiles(recipe, tier);
    const required = files.filter((f) => !f.file.optional);
    const installedRequired = required.filter((f) => f.installed).length;
    const state: InstallState =
      installedRequired === required.length ? 'installed' : installedRequired === 0 && !files.some((f) => f.installed) ? 'missing' : 'partial';
    return {
      state,
      files,
      missingBytes: required.filter((f) => !f.installed).reduce((sum, f) => sum + (f.variant.bytes ?? 0), 0),
      tierVerified: recipe.tiers.includes(tier),
      licenceBlock: licenceBlock(recipe.licence, licenceMode),
    };
  }
}
