import { randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { errors } from '@pepper/core/errors.js';
import { safeResolve } from '@pepper/core/paths.js';
import type { ModeSpec, Recipe, RecipeParam } from '../recipes/schema.js';

/**
 * A request's parameters, checked against the recipe and completed with its
 * defaults: what a job stores (so a retry reproduces it, seed included) and
 * what the bindings put into the graph.
 */

export type ParamValues = Record<string, unknown>;

const MEDIA_TYPES = new Set(['image', 'images', 'audio', 'audios', 'video']);

function coerce(param: RecipeParam, value: unknown): unknown {
  const fail = (why: string) => errors.validation(`${param.name}: ${why}`);
  switch (param.type) {
    case 'string':
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
      if (typeof value !== 'string') throw fail('expected a string');
      if (param.type === 'string' || param.type === 'text') return value;
      if (!value) throw fail('expected an upload name');
      return value;
    case 'images':
    case 'audios': {
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((item) => typeof item === 'string' && item)) throw fail('expected a list of upload names');
      if (param.max_items !== undefined && list.length > param.max_items) {
        throw fail(`at most ${param.max_items} items`);
      }
      return list;
    }
    case 'int':
    case 'seed':
    case 'float': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw fail('expected a number');
      if (param.type !== 'float' && !Number.isInteger(n)) throw fail('expected an integer');
      if (param.min !== undefined && n < param.min) throw fail(`must be at least ${param.min}`);
      if (param.max !== undefined && n > param.max) throw fail(`must be at most ${param.max}`);
      return n;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw fail('expected true or false');
      return value;
    case 'enum':
      if (!param.options?.includes(value as string | number)) {
        throw fail(`expected one of ${param.options?.join(', ')}`);
      }
      return value;
  }
}

/**
 * Complete and validate a request's parameters for one mode. Unknown names
 * are rejected rather than ignored: a typo'd `promt` silently dropped is a
 * render spent on the default prompt. A seed that is absent or negative is
 * drawn here, so the stored job reproduces exactly.
 */
export function resolveParams(recipe: Recipe, mode: ModeSpec, input: ParamValues): ParamValues {
  const known = new Map(recipe.params.map((param) => [param.name, param]));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) {
      throw errors.validation(
        `Recipe "${recipe.id}" has no parameter "${name}" (it takes ${recipe.params.map((p) => p.name).join(', ')})`,
      );
    }
  }
  const values: ParamValues = {};
  for (const param of recipe.params) {
    let value = input[param.name];
    if (value === undefined || value === null || (MEDIA_TYPES.has(param.type) && value === '')) {
      value = mode.defaults[param.name] ?? param.default;
    }
    if (param.type === 'seed' && (value === undefined || (typeof value === 'number' && value < 0))) {
      // Within the seed's own `max` when a node takes less than 47 bits
      // (LongCat-Avatar's sampler stops at 2^31-1).
      value = randomInt(0, Math.min(2 ** 47, (param.max ?? 2 ** 47 - 1) + 1));
    }
    if (value === undefined || value === null) {
      if (param.required) throw errors.validation(`${param.name} is required by recipe "${recipe.id}"`);
      continue;
    }
    values[param.name] = coerce(param, value);
  }
  return values;
}

/** Every upload a request names must exist, checked before a model loads. */
export async function checkUploads(recipe: Recipe, values: ParamValues, uploadsDir: string): Promise<void> {
  for (const param of recipe.params) {
    if (!MEDIA_TYPES.has(param.type) || values[param.name] === undefined) continue;
    const names = Array.isArray(values[param.name]) ? (values[param.name] as string[]) : [values[param.name] as string];
    for (const name of names) {
      try {
        await stat(safeResolve(uploadsDir, name));
      } catch {
        throw errors.inputNotFound(name);
      }
    }
  }
}
