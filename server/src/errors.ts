/**
 * Structured application errors.
 *
 * Every error a client sees carries a stable machine-readable `code` and an
 * HTTP status, serialized as:
 *   { "error": { "code": "MODEL_NOT_FOUND", "message": "…" } }
 *
 * The codes sd-api defined are kept verbatim (clients match on them), with new
 * ones added for the backend-generic process/binary managers. Where sd-api had
 * a per-backend triplet — `LLM_STARTUP_FAILED`, `AUDIO_STARTUP_FAILED`, … —
 * the generic `BACKEND_*` codes carry the backend id in `details` instead, and
 * the old codes stay as aliases so existing clients keep working.
 */

export type ErrorCode =
  // --- Carried over from sd-api (wire-compatible) ---
  | 'VALIDATION_ERROR'
  | 'MODEL_NOT_FOUND'
  | 'INVALID_MODEL'
  | 'MISSING_WEIGHTS'
  | 'GENERATION_FAILED'
  | 'PROCESS_TIMEOUT'
  | 'BINARY_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'OUTPUT_NOT_FOUND'
  | 'INPUT_NOT_FOUND'
  | 'INVALID_PATH'
  | 'DOWNLOAD_FAILED'
  | 'DOWNLOAD_NOT_FOUND'
  | 'LLM_BINARY_NOT_FOUND'
  | 'LLM_STARTUP_FAILED'
  | 'LLM_SERVER_UNAVAILABLE'
  | 'LLM_UPSTREAM_ERROR'
  | 'AUDIO_BINARY_NOT_FOUND'
  | 'AUDIO_STARTUP_FAILED'
  | 'AUDIO_SERVER_UNAVAILABLE'
  | 'AUDIO_UPSTREAM_ERROR'
  | 'AUDIO_VOICE_REF_NOT_FOUND'
  | 'INTERNAL_ERROR'
  // --- New: backend-generic lifecycle ---
  | 'BACKEND_NOT_FOUND'
  | 'BACKEND_BINARY_NOT_FOUND'
  | 'BACKEND_STARTUP_FAILED'
  | 'BACKEND_UNAVAILABLE'
  | 'BACKEND_UPSTREAM_ERROR'
  | 'BACKEND_INSTALL_FAILED'
  | 'CATALOGUE_UNAVAILABLE'
  | 'JOB_CONFLICT'
  | 'UNSUPPORTED';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Per-backend aliases for the generic lifecycle codes. sd-api clients match on
 * `LLM_STARTUP_FAILED` / `AUDIO_SERVER_UNAVAILABLE` and friends, so a request
 * that fails the same way must still report the same code — the generic code
 * is only used for backends sd-api never had (python), where nothing can be
 * relying on a legacy name yet.
 */
const BACKEND_ERROR_ALIASES: Record<string, Partial<Record<string, ErrorCode>>> = {
  llamacpp: {
    BACKEND_BINARY_NOT_FOUND: 'LLM_BINARY_NOT_FOUND',
    BACKEND_STARTUP_FAILED: 'LLM_STARTUP_FAILED',
    BACKEND_UNAVAILABLE: 'LLM_SERVER_UNAVAILABLE',
    BACKEND_UPSTREAM_ERROR: 'LLM_UPSTREAM_ERROR',
  },
  audiocpp: {
    BACKEND_BINARY_NOT_FOUND: 'AUDIO_BINARY_NOT_FOUND',
    BACKEND_STARTUP_FAILED: 'AUDIO_STARTUP_FAILED',
    BACKEND_UNAVAILABLE: 'AUDIO_SERVER_UNAVAILABLE',
    BACKEND_UPSTREAM_ERROR: 'AUDIO_UPSTREAM_ERROR',
  },
  sdcpp: {
    BACKEND_BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
  },
};

function backendCode(backend: string, generic: ErrorCode): ErrorCode {
  return BACKEND_ERROR_ALIASES[backend]?.[generic] ?? generic;
}

export const errors = {
  validation: (msg: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', msg, 400, details),
  modelNotFound: (name: string) => new AppError('MODEL_NOT_FOUND', `Model not found: ${name}`, 404),
  invalidModel: (msg: string) => new AppError('INVALID_MODEL', msg, 422),
  missingWeights: (msg: string) => new AppError('MISSING_WEIGHTS', msg, 422),
  jobNotFound: (id: string) => new AppError('JOB_NOT_FOUND', `Job not found: ${id}`, 404),
  jobConflict: (msg: string) => new AppError('JOB_CONFLICT', msg, 409),
  outputNotFound: (name: string) =>
    new AppError('OUTPUT_NOT_FOUND', `Output not found: ${name}`, 404),
  inputNotFound: (name: string) => new AppError('INPUT_NOT_FOUND', `Upload not found: ${name}`, 404),
  invalidPath: (msg: string) => new AppError('INVALID_PATH', msg, 400),
  downloadFailed: (msg: string) => new AppError('DOWNLOAD_FAILED', msg, 502),
  downloadNotFound: (id: string) =>
    new AppError('DOWNLOAD_NOT_FOUND', `Download not found: ${id}`, 404),
  generationFailed: (msg: string, details?: unknown) =>
    new AppError('GENERATION_FAILED', msg, 500, details),
  processTimeout: (ms: number) =>
    new AppError('PROCESS_TIMEOUT', `Process exceeded its timeout of ${ms}ms`, 504),
  audioVoiceRefNotFound: (name: string) =>
    new AppError('AUDIO_VOICE_REF_NOT_FOUND', `Voice reference audio not found: ${name}`, 404),
  catalogueUnavailable: (msg: string) => new AppError('CATALOGUE_UNAVAILABLE', msg, 503),
  unsupported: (msg: string) => new AppError('UNSUPPORTED', msg, 501),
  internal: (msg: string) => new AppError('INTERNAL_ERROR', msg, 500),

  // --- Backend lifecycle (aliased to sd-api's per-backend codes) ---
  backendNotFound: (id: string) => new AppError('BACKEND_NOT_FOUND', `Unknown backend: ${id}`, 404),
  backendBinaryNotFound: (backend: string, path: string) =>
    new AppError(
      backendCode(backend, 'BACKEND_BINARY_NOT_FOUND'),
      `${backend} binary not found: ${path}`,
      500,
      { backend },
    ),
  backendStartupFailed: (backend: string, msg: string) =>
    new AppError(backendCode(backend, 'BACKEND_STARTUP_FAILED'), msg, 500, { backend }),
  backendUnavailable: (backend: string, msg: string) =>
    new AppError(backendCode(backend, 'BACKEND_UNAVAILABLE'), msg, 502, { backend }),
  backendUpstreamError: (backend: string, msg: string) =>
    new AppError(backendCode(backend, 'BACKEND_UPSTREAM_ERROR'), msg, 502, { backend }),
  backendInstallFailed: (backend: string, msg: string) =>
    new AppError('BACKEND_INSTALL_FAILED', msg, 502, { backend }),
};
