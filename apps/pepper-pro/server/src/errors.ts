import { AppError } from '@pepper/core/errors.js';

export { AppError, errors } from '@pepper/core/errors.js';

/** Pepper Pro's own errors, alongside the shared `errors`. */
export const proErrors = {
  recipeNotFound: (id: string) => new AppError('RECIPE_NOT_FOUND', `Recipe not found: ${id}`, 404),
  recipeNotInstalled: (id: string, missing: string[]) =>
    new AppError(
      'RECIPE_NOT_INSTALLED',
      `Recipe "${id}" is missing ${missing.length} file(s): ${missing.join(', ')}. Install it first.`,
      409,
      { missing },
    ),
  recipeLicence: (msg: string) => new AppError('RECIPE_LICENCE', msg, 403),
  engineFailed: (msg: string, details?: unknown) => new AppError('ENGINE_FAILED', msg, 500, details),
  outOfMemory: (msg: string) => new AppError('OUT_OF_MEMORY', msg, 507),
  projectNotFound: (id: string) => new AppError('PROJECT_NOT_FOUND', `Project not found: ${id}`, 404),
  shotNotFound: (id: string) => new AppError('SHOT_NOT_FOUND', `Shot not found: ${id}`, 404),
  takeNotFound: (id: string) => new AppError('TAKE_NOT_FOUND', `Take not found: ${id}`, 404),
};
