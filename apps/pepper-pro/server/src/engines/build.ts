import type { ObjectInfo, Prompt } from '../comfy/client.js';
import { clonePrompt, prune, retainReachable, setInput, validatePrompt, type ValidateOptions } from '../comfy/graph.js';
import { errors } from '@pepper/core/errors.js';
import type { ResolvedFile } from '../recipes/store.js';
import type { ModeSpec, Recipe, WorkflowSpec } from '../recipes/schema.js';
import type { ParamValues } from './params.js';

/**
 * Turn a recipe mode and a request's parameters into the prompt ComfyUI
 * runs: the mode's constants, then every binding, then the list slots the
 * request left empty pruned away, then a validation pass so a mismatch is a
 * clear 400 here rather than a traceback from inside ComfyUI.
 */
export interface BuildInput {
  recipe: Recipe;
  mode: ModeSpec;
  workflow: WorkflowSpec;
  template: Prompt;
  values: ParamValues;
  files: ResolvedFile[];
  /** Validate against these node types when given. */
  objectInfo?: ObjectInfo;
  validate?: ValidateOptions;
}

export function buildPrompt(input: BuildInput): Prompt {
  const { recipe, mode, workflow, values, files } = input;
  const prompt = clonePrompt(input.template);
  const unused = new Set<string>();

  try {
    for (const { node, input: name, value } of mode.set) setInput(prompt, node, name, value);

    for (const binding of workflow.bindings) {
      if ('file' in binding) {
        const file = files.find((f) => f.file.id === binding.file);
        if (!file) throw new Error(`no file "${binding.file}"`);
        setInput(prompt, binding.node, binding.input, file.name);
      } else if ('nodes' in binding) {
        // A single optional input (a last frame) binds like a one-slot list,
        // so leaving it out prunes its loader instead of loading a stale name.
        const raw = values[binding.param];
        const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
        binding.nodes.forEach((target, index) => {
          if (index < items.length) setInput(prompt, target.node, target.input, items[index]);
          else unused.add(target.node);
        });
        if (items.length > binding.nodes.length) {
          throw errors.validation(`${binding.param}: this recipe takes at most ${binding.nodes.length}`);
        }
      } else if (values[binding.param] !== undefined) {
        setInput(prompt, binding.node, binding.input, values[binding.param]);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err;
    throw errors.validation(`Recipe "${recipe.id}" does not match its workflow: ${(err as Error).message}`);
  }

  prune(prompt, unused, input.objectInfo, workflow.bypass);
  retainReachable(
    prompt,
    workflow.outputs.map((o) => o.node),
  );

  if (input.objectInfo) {
    const issues = validatePrompt(prompt, input.objectInfo, input.validate);
    if (issues.length > 0) {
      throw errors.validation(
        `Recipe "${recipe.id}" does not validate against this ComfyUI: ` +
          issues
            .slice(0, 5)
            .map((issue) => `node ${issue.node}: ${issue.message}`)
            .join('; '),
        issues,
      );
    }
  }
  return prompt;
}
