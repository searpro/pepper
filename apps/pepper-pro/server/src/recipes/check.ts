import type { ObjectInfo, Prompt } from '../comfy/client.js';
import { isLink } from '../comfy/graph.js';
import type { Tier } from '../config.js';
import { buildPrompt } from '../engines/build.js';
import { resolveParams, type ParamValues } from '../engines/params.js';
import type { Recipe, RecipeParam } from './schema.js';
import { variantFor, variantName, variantUrl, type ResolvedFile } from './store.js';

/**
 * A recipe checked without running it: every mode is built twice — with only
 * the required parameters, and with every optional input filled — and each
 * prompt is validated. Against a live ComfyUI's `/object_info` this catches
 * a renamed input or a node pack missing from the image; without one it
 * still catches bindings to nodes that do not exist and links left dangling
 * by pruning. `src/scripts/validate-recipes.ts` runs it in the image build and on a pod.
 */

export interface RecipeCheck {
  recipe: string;
  mode: string;
  inputs: 'required' | 'all';
  issues: string[];
}

const SAMPLE: Partial<Record<RecipeParam['type'], unknown>> = {
  string: 'sample',
  text: 'A sample prompt.',
  image: 'sample.png',
  audio: 'sample.wav',
  video: 'sample.mp4',
  boolean: true,
};

/** A value for a parameter; lists get one item, or every slot when filling all inputs. */
function sample(param: RecipeParam, inputs: 'required' | 'all'): unknown {
  const count = inputs === 'all' ? (param.max_items ?? 1) : 1;
  if (param.type === 'images') return Array.from({ length: count }, (_, i) => `sample-${i}.png`);
  if (param.type === 'audios') return Array.from({ length: count }, (_, i) => `sample-${i}.wav`);
  if (param.type === 'enum') return param.options?.[0];
  if (param.type === 'int' || param.type === 'float' || param.type === 'seed') return param.min ?? 1;
  return SAMPLE[param.type];
}

/** Values for one check: required params, or every param, at sample values over the defaults. */
export function sampleValues(recipe: Recipe, mode: string, inputs: 'required' | 'all'): ParamValues {
  const given: ParamValues = {};
  for (const param of recipe.params) {
    const media = ['image', 'images', 'audio', 'audios', 'video'].includes(param.type);
    if (param.required || (inputs === 'all' && media && param.default === undefined)) given[param.name] = sample(param, inputs);
  }
  return resolveParams(recipe, recipe.modes[mode], given);
}

/** The recipe's files as the engine would bind them on a tier, installed or not. */
export function plannedFiles(recipe: Recipe, tier: Tier): ResolvedFile[] {
  return recipe.files.map((file) => {
    const variant = variantFor(file, tier);
    return { file, variant, name: variantName(variant), path: '', url: variantUrl(variant), installed: false };
  });
}

/** Links that point at nodes the prompt does not have. */
function danglingLinks(prompt: Prompt): string[] {
  const issues: string[] = [];
  for (const [id, node] of Object.entries(prompt)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value) && !prompt[value[0]]) issues.push(`node ${id}: input "${input}" links to missing node ${value[0]}`);
    }
  }
  return issues;
}

export function checkRecipe(
  recipe: Recipe,
  template: (workflow: string) => Prompt,
  options: { tier: Tier; objectInfo?: ObjectInfo },
): RecipeCheck[] {
  const results: RecipeCheck[] = [];
  const files = plannedFiles(recipe, options.tier);
  for (const [modeName, mode] of Object.entries(recipe.modes)) {
    const workflow = recipe.workflows[mode.workflow];
    for (const inputs of ['required', 'all'] as const) {
      const issues: string[] = [];
      try {
        const prompt = buildPrompt({
          recipe,
          mode,
          workflow,
          template: template(mode.workflow),
          values: sampleValues(recipe, modeName, inputs),
          files,
          objectInfo: options.objectInfo,
          validate: { ignoreFileChoices: true },
        });
        issues.push(...danglingLinks(prompt));
        for (const output of workflow.outputs) {
          if (!prompt[output.node]) issues.push(`output node ${output.node} was pruned away`);
        }
      } catch (err) {
        const details = (err as { details?: { node: string; message: string }[] }).details;
        if (Array.isArray(details)) issues.push(...details.map((d) => `node ${d.node}: ${d.message}`));
        else issues.push((err as Error).message);
      }
      results.push({ recipe: recipe.id, mode: modeName, inputs, issues });
    }
  }
  return results;
}
