import { z } from 'zod';
import { TIERS } from '../config.js';
import { COMFY_FOLDERS } from '../paths.js';

/**
 * A recipe: what a user installs and the curator maintains
 * (docs/PEPPER-PRO.md §6). It pins everything that decides how a generation
 * looks — the ComfyUI graph, the exact files (per hardware tier), the custom
 * node packs — and says how a request's parameters reach the graph.
 *
 * Graph structure is code: templates live in the repository next to the
 * recipe (`recipes/<id>/`), in ComfyUI's API format, and change through
 * review. Parameters reach a graph only through `bindings`, which are data;
 * a binding that no longer matches a node fails validation, not a user's job.
 */

export const RECIPE_KINDS = ['image', 'video', 'audio'] as const;
export type RecipeKind = (typeof RECIPE_KINDS)[number];

/** One downloadable file, as it exists for some set of hardware tiers. */
const fileVariantSchema = z
  .object({
    /** Tiers this variant is for; absent means every tier. */
    tiers: z.array(z.enum(TIERS)).optional(),
    /** HuggingFace repository, e.g. "Comfy-Org/MiniMax-H3". */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
    /** Path inside the repository. */
    path: z.string().min(1).optional(),
    revision: z.string().default('main'),
    /** A direct URL, for files that are not on HuggingFace. */
    url: z.string().url().optional(),
    /** File name on disk; defaults to the last segment of `path` or `url`. */
    name: z.string().regex(/^[^/\\]+$/).optional(),
    bytes: z.number().int().positive().optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((v) => Boolean(v.url) || Boolean(v.repo && v.path), {
    message: 'a file variant needs either `url`, or `repo` and `path`',
  });

const fileSchema = z.object({
  /** Referenced by `{ file }` bindings. */
  id: z.string().regex(/^[a-z0-9_-]+$/),
  folder: z.enum(COMFY_FOLDERS),
  label: z.string(),
  description: z.string().optional(),
  /**
   * Installed with the recipe but not needed by every mode (a turbo LoRA the
   * finish mode does not use). Absent optional files do not make the recipe
   * unusable; a mode that binds one does.
   */
  optional: z.boolean().default(false),
  variants: z.array(fileVariantSchema).min(1),
});

export const PARAM_TYPES = [
  'string',
  'text',
  'int',
  'float',
  'boolean',
  'enum',
  'seed',
  /** One upload name (an image in uploads). */
  'image',
  /** Several upload names. */
  'images',
  'audio',
  'audios',
  'video',
] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

const paramSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(PARAM_TYPES),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.union([z.string(), z.number()])).optional(),
  /** For list types: how many items the graph has slots for. */
  max_items: z.number().int().positive().optional(),
});

const target = z.object({ node: z.string(), input: z.string() });

/**
 * How one value reaches the graph:
 * - `param` + `node`/`input`: a request parameter into one input (through
 *   `map` when the graph's value differs from the option shown);
 * - `param` + `nodes`: a list parameter, one item per slot; slots left empty
 *   are pruned from the graph (see `graph.ts`);
 * - `file`: the installed file name of a recipe file, for a loader's input.
 */
const bindingSchema = z.union([
  z.object({
    param: z.string(),
    node: z.string(),
    input: z.string(),
    /** Graph values for an enum's options, when the graph wants an index or a code. */
    map: z.record(z.unknown()).optional(),
  }),
  z.object({ param: z.string(), nodes: z.array(target).min(1) }),
  z.object({ file: z.string(), node: z.string(), input: z.string() }),
]);
export type Binding = z.infer<typeof bindingSchema>;

const workflowSchema = z.object({
  /** API-format JSON, relative to the recipe's directory. */
  file: z.string().regex(/^[\w./-]+\.json$/),
  bindings: z.array(bindingSchema),
  /** Nodes whose files are the result, in order. */
  outputs: z.array(z.object({ node: z.string(), kind: z.enum(['image', 'video', 'audio']) })).min(1),
  /**
   * Relative cost of the nodes that report step progress, so a job's bar
   * moves evenly across a two-stage render instead of filling twice.
   */
  progress: z.record(z.number().positive()).optional(),
  /**
   * Nodes to bypass when none of their `requires` inputs is connected (see
   * `applyBypasses`): an audio guide with no audio, a mask with no image.
   */
  bypass: z
    .array(z.object({ node: z.string(), requires: z.array(z.string()).min(1), through: z.record(z.string()) }))
    .default([]),
});
export type WorkflowSpec = z.infer<typeof workflowSchema>;

const modeSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  workflow: z.string(),
  /** Constants this mode fixes, e.g. the turbo switch and its step count. */
  set: z.array(target.extend({ value: z.unknown() })).default([]),
  /** Parameter defaults for this mode, over the recipe's own. */
  defaults: z.record(z.unknown()).default({}),
});
export type ModeSpec = z.infer<typeof modeSchema>;

export const LICENCE_COMMERCIAL = ['yes', 'no', 'under-1M', 'under-10M', 'under-20M'] as const;

const licenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url().optional(),
  /** Whether and up to what revenue the weights may be used commercially. */
  commercial: z.enum(LICENCE_COMMERCIAL),
  /** Territories where the weights and their outputs may not be used at all. */
  excluded_territories: z.array(z.string()).default([]),
  /** Text a commercial product must show in its interface. */
  ui_notice: z.string().optional(),
  /** Anything else a user must do, e.g. disclose AI generation. */
  obligations: z.array(z.string()).default([]),
});
export type Licence = z.infer<typeof licenceSchema>;

export const recipeSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.number().int().positive(),
    kind: z.enum(RECIPE_KINDS),
    name: z.string(),
    description: z.string(),
    /**
     * Recipes that load the same models. Switching family between jobs is
     * when ComfyUI is asked to unload, so auditioning takes of one recipe
     * keeps its weights warm.
     */
    family: z.string(),
    /** What it can do, for the shot editor and the MCP planner. */
    capabilities: z.array(z.string()).default([]),
    licence: licenceSchema,
    /** Custom node packs, by directory name, each pinned to a commit in the image. */
    nodes: z
      .array(z.object({ name: z.string(), repo: z.string().url(), commit: z.string().regex(/^[0-9a-f]{7,40}$/) }))
      .default([]),
    /** Which ComfyUI instance runs it (a second instance isolates conflicting packs). */
    instance: z.string().default('main'),
    files: z.array(fileSchema),
    params: z.array(paramSchema),
    workflows: z.record(workflowSchema),
    modes: z.record(modeSchema),
    /** The mode used when a request names none. */
    default_mode: z.string(),
    /** Tiers the recipe has been checked on; others are allowed but flagged. */
    tiers: z.array(z.enum(TIERS)).min(1),
    samples: z.array(z.object({ url: z.string().url(), caption: z.string().optional() })).default([]),
    /** When and where the recipe last passed its golden shots. */
    verified: z.object({ date: z.string(), gpu: z.string(), seconds: z.number().optional(), notes: z.string().optional() }).optional(),
    notes: z.string().optional(),
  })
  .superRefine((recipe, ctx) => {
    const params = new Set(recipe.params.map((p) => p.name));
    const files = new Set(recipe.files.map((f) => f.id));
    if (!recipe.modes[recipe.default_mode]) {
      ctx.addIssue({ code: 'custom', message: `default_mode "${recipe.default_mode}" is not a mode` });
    }
    for (const [name, mode] of Object.entries(recipe.modes)) {
      if (!recipe.workflows[mode.workflow]) {
        ctx.addIssue({ code: 'custom', message: `mode "${name}" uses unknown workflow "${mode.workflow}"` });
      }
      for (const key of Object.keys(mode.defaults)) {
        if (!params.has(key)) ctx.addIssue({ code: 'custom', message: `mode "${name}" defaults unknown param "${key}"` });
      }
    }
    for (const [name, workflow] of Object.entries(recipe.workflows)) {
      for (const binding of workflow.bindings) {
        if ('file' in binding && !files.has(binding.file)) {
          ctx.addIssue({ code: 'custom', message: `workflow "${name}" binds unknown file "${binding.file}"` });
        }
        if ('param' in binding && !params.has(binding.param)) {
          ctx.addIssue({ code: 'custom', message: `workflow "${name}" binds unknown param "${binding.param}"` });
        }
      }
    }
  });

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeFile = Recipe['files'][number];
export type RecipeParam = Recipe['params'][number];
export type FileVariant = RecipeFile['variants'][number];
