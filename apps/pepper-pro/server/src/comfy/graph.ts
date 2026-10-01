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

/**
 * Whether an input is optional. Growable inputs (`ref_images.ref_image_2`)
 * are named after their group, which is what `/object_info` declares.
 */
function inputOptional(info: NodeInfo | undefined, input: string): boolean {
  if (!info) return false;
  const optional = info.input.optional ?? {};
  if (input in optional) return true;
  if (!input.includes('.')) return false;
  const group = input.split('.')[0];
  // One member of a growable group can go even when the group itself is
  // required (Qwen's `images`): ComfyUI checks the group's minimum, not slots.
  return group in optional || info.input.required?.[group]?.[0] === 'COMFY_AUTOGROW_V3';
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
export function prune(prompt: Prompt, remove: Iterable<string>, info?: ObjectInfo, bypasses: Bypass[] = []): void {
  const bypassable = new Map(bypasses.map((b) => [b.node, b]));
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
        const bypass = bypassable.get(otherId);
        if (inputOptional(info?.[node.class_type], input) || bypass?.requires.includes(input)) {
          delete node.inputs[input];
        } else {
          queue.push(otherId);
        }
      }
    }
  }
  // A bypassable node that lost what it needed passes its inputs through
  // rather than taking the rest of the graph with it.
  applyBypasses(prompt, bypasses);
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
 * `clip_name2`, `text_encoder`, ModelPatchLoader's `name`, LongCat's `vae` and `lora`, LoadImage's `image`…). `sampler_name` is a real choice list.
 */
const FILE_INPUT = /^(?!sampler_name$)(.+_name\d*|name|vae|lora|text_encoder\d*|image|audio|video|file)$/;

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
      // A dynamic group (`values`, `images`) is present as its members (`values.a`).
      const present = input in node.inputs || Object.keys(node.inputs).some((name) => name.startsWith(`${input}.`));
      if (!present) issues.push({ node: id, message: `${node.class_type} is missing required input "${input}"` });
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
          continue;
        }
        const wanted = linkType(declared[input] ?? groupDeclaration(spec, input));
        const given = outputs?.[value[1]];
        if (wanted && typeof given === 'string' && !typesMatch(given, wanted)) {
          issues.push({ node: id, message: `input "${input}" takes ${wanted} but is linked to ${given} from ${source.class_type}` });
        }
        continue;
      }
      const decl = declared[input];
      // Inputs not declared are allowed: dynamic inputs (`values.a`,
      // `format.codec`) are how several core nodes take variable arguments.
      if (!decl) continue;
      if (typeof value === 'number' && (decl[0] === 'INT' || decl[0] === 'FLOAT')) {
        const bounds = (decl[1] ?? {}) as { min?: number; max?: number };
        if (bounds.min !== undefined && value < bounds.min) issues.push({ node: id, message: `${node.class_type}.${input} is ${value}, below its minimum ${bounds.min}` });
        if (bounds.max !== undefined && value > bounds.max) issues.push({ node: id, message: `${node.class_type}.${input} is ${value}, above its maximum ${bounds.max}` });
        continue;
      }
      const choices = choiceList(decl);
      // An empty list is one the node fills at run time (CustomCombo's options
      // are its own inputs); only ComfyUI can check those.
      if (!choices || choices.length === 0) continue;
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
 * The declaration of one member of a growable group (`ref_images.ref_image_0`,
 * `values.a`): the group's template input. Other dotted inputs (a dynamic
 * combo's `resize_type.multiplier`) have no single declaration.
 */
function groupDeclaration(spec: NodeInfo, input: string): unknown[] | undefined {
  const [group] = input.split('.');
  if (group === input) return undefined;
  const decl = spec.input.required?.[group] ?? spec.input.optional?.[group];
  if (decl?.[0] !== 'COMFY_AUTOGROW_V3') return undefined;
  const template = (decl[1] as { template?: { input?: { required?: object; optional?: object } } } | undefined)?.template?.input;
  return Object.values({ ...template?.required, ...template?.optional })[0] as unknown[] | undefined;
}

/**
 * The data type an input accepts, when it is one a link can be checked
 * against. Wildcards and ComfyUI's V3 meta types (match-type, dynamic combo)
 * are resolved at run time, so they are not checked here.
 */
function linkType(decl: unknown[] | undefined): string | undefined {
  const type = decl?.[0];
  if (typeof type !== 'string' || type === '*' || type === 'COMBO' || type.startsWith('COMFY_')) return undefined;
  return type;
}

/** Both sides may list several types ("FLOAT,INT,BOOLEAN"); any shared one links. */
function typesMatch(given: string, wanted: string): boolean {
  if (given === '*' || given.startsWith('COMFY_')) return true;
  const accepted = wanted.split(',');
  return given.split(',').some((type) => accepted.includes(type));
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

/**
 * ComfyUI's "bypass" as data. A node that only makes sense with at least one
 * of `requires` connected (an audio guide without audio) is removed when none
 * is, and whatever consumed its outputs is reconnected to the inputs named in
 * `through` — output 0 of a guide node passes its `positive` input through.
 */
export interface Bypass {
  node: string;
  requires: string[];
  through: Record<string, string>;
}

export function applyBypasses(prompt: Prompt, bypasses: Bypass[]): void {
  for (const bypass of bypasses) {
    const node = prompt[bypass.node];
    if (!node) continue;
    if (bypass.requires.some((input) => isLink(node.inputs[input]))) continue;
    delete prompt[bypass.node];
    for (const other of Object.values(prompt)) {
      for (const [input, value] of Object.entries(other.inputs)) {
        if (!isLink(value) || value[0] !== bypass.node) continue;
        const replacement = node.inputs[bypass.through[String(value[1])]];
        if (replacement === undefined) delete other.inputs[input];
        else other.inputs[input] = replacement;
      }
    }
  }
}

/**
 * Keep only the output nodes and what they depend on. A template carries
 * helpers a request does not use (a resolution picker whose values were
 * bound directly, a loader for an input left empty); ComfyUI would skip
 * them anyway, but a prompt that holds only what runs is one validation and
 * the logs can be read against.
 */
export function retainReachable(prompt: Prompt, outputs: string[]): void {
  const keep = new Set<string>();
  const stack = outputs.filter((id) => prompt[id]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const value of Object.values(prompt[id]?.inputs ?? {})) {
      if (isLink(value) && prompt[value[0]]) stack.push(value[0]);
    }
  }
  for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
}
