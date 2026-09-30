import type { NodeInfo, ObjectInfo, Prompt } from './client.js';

/**
 * Operations on API-format prompts: setting inputs, pruning the parts a
 * request does not use, and validating a prompt against `/object_info`
 * before ComfyUI sees it.
 */

export type Link = [string, number];

export function isLink(value: unknown): value is Link {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';
}

export function clonePrompt(prompt: Prompt): Prompt {
  return JSON.parse(JSON.stringify(prompt)) as Prompt;
}

export class GraphError extends Error {}

/** Set one input on one node. The node must exist; the input need not (optional inputs are often absent). */
export function setInput(prompt: Prompt, node: string, input: string, value: unknown): void {
  const target = prompt[node];
  if (!target) throw new GraphError(`the workflow has no node "${node}"`);
  target.inputs[input] = value;
}

function inputOptional(info: NodeInfo | undefined, input: string): boolean {
  return Boolean(info?.input.optional && input in info.input.optional);
}

/**
 * Remove nodes, and then whatever can no longer run without them.
 *
 * A node that fed a removed node through an *optional* input simply loses
 * that input (a reference image slot left empty); a node that needed it
 * through a *required* input is removed too, and the cascade continues. What
 * is optional comes from `/object_info`; without it every input counts as
 * required, which removes more than necessary but never leaves a dangling
 * link.
 */
export function prune(prompt: Prompt, remove: Iterable<string>, info?: ObjectInfo): void {
  const queue = [...remove];
  const removed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (removed.has(id) || !prompt[id]) continue;
    removed.add(id);
    delete prompt[id];
    for (const [otherId, node] of Object.entries(prompt)) {
      for (const [input, value] of Object.entries(node.inputs)) {
        if (!isLink(value) || value[0] !== id) continue;
        if (inputOptional(info?.[node.class_type], input)) delete node.inputs[input];
        else queue.push(otherId);
      }
    }
  }
}

export interface ValidationIssue {
  node: string;
  message: string;
}

export interface ValidateOptions {
  /**
   * Skip checking file-name inputs against the installed files. Smoke tests
   * validate graph structure on a machine with no models; the engine checks
   * files itself before queueing.
   */
  ignoreFileChoices?: boolean;
}

/**
 * Inputs whose choices are lists of files on disk (`unet_name`, `lora_name`,
 * `clip_name2`, LoadImage's `image`…). `sampler_name` is a real choice list.
 */
const FILE_INPUT = /^(?!sampler_name$)(.+_name\d*|image|audio|video|file)$/;

/**
 * Check a prompt against the node types a ComfyUI knows: every class exists,
 * every required input is present, links point at nodes and at outputs they
 * have, and choice inputs hold one of their choices.
 */
export function validatePrompt(prompt: Prompt, info: ObjectInfo, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [id, node] of Object.entries(prompt)) {
    const spec = info[node.class_type];
    if (!spec) {
      issues.push({ node: id, message: `unknown node type ${node.class_type} (is its node pack installed?)` });
      continue;
    }
    for (const input of Object.keys(spec.input.required ?? {})) {
      if (!(input in node.inputs)) issues.push({ node: id, message: `${node.class_type} is missing required input "${input}"` });
    }
    const declared = { ...(spec.input.required ?? {}), ...(spec.input.optional ?? {}) };
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value)) {
        const source = prompt[value[0]];
        if (!source) {
          issues.push({ node: id, message: `input "${input}" links to missing node ${value[0]}` });
          continue;
        }
        const outputs = info[source.class_type]?.output;
        if (outputs && value[1] >= outputs.length) {
          issues.push({ node: id, message: `input "${input}" links to output ${value[1]} of ${source.class_type}, which has ${outputs.length}` });
        }
        continue;
      }
      const decl = declared[input];
      // Inputs not declared are allowed: dynamic inputs (`values.a`,
      // `format.codec`) are how several core nodes take variable arguments.
      if (!decl) continue;
      const choices = choiceList(decl);
      if (!choices) continue;
      if (options.ignoreFileChoices && FILE_INPUT.test(input)) continue;
      if (!choices.includes(value as string)) {
        issues.push({
          node: id,
          message: `${node.class_type}.${input} is "${String(value)}", not one of ${choices.slice(0, 8).join(', ')}${choices.length > 8 ? '…' : ''}`,
        });
      }
    }
  }
  return issues;
}

/**
 * The choices of a combo input, in either `/object_info` spelling: the
 * classic `[["a", "b"], {...}]` or the newer `["COMBO", { options: [...] }]`.
 */
function choiceList(decl: unknown[]): string[] | null {
  if (Array.isArray(decl[0])) return decl[0] as string[];
  if (decl[0] === 'COMBO') {
    const options = (decl[1] as { options?: unknown } | undefined)?.options;
    return Array.isArray(options) ? (options as string[]) : null;
  }
  return null;
}

/** The node types a prompt uses, for reporting which node packs it needs. */
export function classTypes(prompt: Prompt): string[] {
  return [...new Set(Object.values(prompt).map((node) => node.class_type))].sort();
}
