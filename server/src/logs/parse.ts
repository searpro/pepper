/**
 * Turn one raw line of backend output into a level + message (requirement 5:
 * "support all levels of logging supported by the process … if nothing is
 * supported try to stream the process stdout to the parent").
 *
 * sd-api forwarded every child-process line at pino's `debug` level regardless
 * of what the line actually said, so a CUDA OOM and a tensor-shape trace
 * arrived indistinguishable — which is precisely the "current implementation
 * is not helping" complaint. These backends *do* emit levels, just not in a
 * machine-readable format, so the level is recovered from the line's own text:
 *
 *   stable-diffusion.cpp  `[INFO ] stable-diffusion.cpp:1454 - loading model`
 *   llama.cpp             `srv  load_model: loading model` / `[ERROR] …`
 *   ggml (shared)         `ggml_cuda_init: found 1 CUDA device`
 *
 * Anything unrecognised falls back to `info` for stdout and `warn` for stderr,
 * rather than being dropped or uniformly flagged as an error — these tools
 * write ordinary progress chatter to stderr, so treating the stream itself as
 * a severity signal would mark a healthy startup as failing.
 */

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ParsedBackendLine {
  level: LogLevelName;
  /** The line with its level/source decoration stripped, where there was any. */
  message: string;
  /** Source-file annotation the backend included, e.g. `stable-diffusion.cpp:1454`. */
  origin?: string;
}

/** `[INFO ] file.cpp:123 - message` / `[ERROR] message` */
const BRACKETED_RE = /^\s*\[\s*(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s*\]\s*(?:([\w.+-]+:\d+)\s*[-:]\s*)?(.*)$/i;

/** llama.cpp's newer `LOG_INF`-style prefixes: `I 00:00:00.000 message`. */
const SHORT_LEVEL_RE = /^\s*([TDIWEF])\s+\d{2}:\d{2}:\d{2}[.\d]*\s+(.*)$/;

/** Bare `error:` / `warning:` sentence openers, which every one of these tools uses. */
const KEYWORD_RE = /^\s*(?:(error|fatal|failed|warning|warn|debug|info|note)\s*:)\s*(.*)$/i;

const LEVEL_ALIASES: Record<string, LogLevelName> = {
  trace: 'trace',
  t: 'trace',
  debug: 'debug',
  d: 'debug',
  info: 'info',
  i: 'info',
  note: 'info',
  warn: 'warn',
  warning: 'warn',
  w: 'warn',
  error: 'error',
  failed: 'error',
  e: 'error',
  fatal: 'fatal',
  critical: 'fatal',
  f: 'fatal',
};

/**
 * Substrings that mark a line as an error even without a level prefix. These
 * are the failures that actually matter operationally — an unreadable model,
 * an exhausted GPU, an assertion — and every one of them is emitted by at
 * least one of the three backends as bare text.
 */
const ERROR_HINTS = [
  'out of memory',
  'cuda error',
  'failed to allocate',
  'failed to load',
  'unable to load',
  'no such file',
  'segmentation fault',
  'assertion',
  'aborted',
  'not supported',
  'unsupported',
  'invalid model',
];

const WARN_HINTS = ['deprecated', 'falling back', 'fallback', 'ignoring', 'skipping', 'retry'];

export function parseBackendLine(line: string, stream: 'stdout' | 'stderr'): ParsedBackendLine {
  const bracketed = BRACKETED_RE.exec(line);
  if (bracketed) {
    return {
      level: LEVEL_ALIASES[bracketed[1].toLowerCase()] ?? 'info',
      origin: bracketed[2],
      message: bracketed[3] || line.trim(),
    };
  }

  const short = SHORT_LEVEL_RE.exec(line);
  if (short) {
    return {
      level: LEVEL_ALIASES[short[1].toLowerCase()] ?? 'info',
      message: short[2],
    };
  }

  const keyword = KEYWORD_RE.exec(line);
  if (keyword) {
    return {
      level: LEVEL_ALIASES[keyword[1].toLowerCase()] ?? 'info',
      message: keyword[2] || line.trim(),
    };
  }

  const lower = line.toLowerCase();
  if (ERROR_HINTS.some((hint) => lower.includes(hint))) {
    return { level: 'error', message: line.trim() };
  }
  if (WARN_HINTS.some((hint) => lower.includes(hint))) {
    return { level: 'warn', message: line.trim() };
  }

  // Nothing recognisable: pass the line through. stderr is the noisier stream
  // for these tools but not inherently a failure signal, so it is nudged one
  // level up rather than being reported as an error.
  return { level: stream === 'stderr' ? 'warn' : 'info', message: line.trim() };
}

/**
 * Parse a `step/total` progress fragment out of a backend line
 * (requirement 5: "stream progress if supported").
 *
 * stable-diffusion.cpp renders a sampling bar containing the fragment:
 *   `|==============>      | 7/20 - 1.13s/it`
 * Matching the numeric fragment rather than the surrounding decoration keeps
 * this working across builds, whose bar formatting drifts.
 */
const STEP_RE = /(?:^|[\s|>\]])(\d+)\s*\/\s*(\d+)(?=[\s\-]|s\/it|it\/s|$)/;

export interface StepProgress {
  step: number;
  total: number;
  /** 0..1 */
  progress: number;
}

export function parseProgress(line: string): StepProgress | null {
  const m = STEP_RE.exec(line);
  if (!m) return null;
  const step = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0) return null;
  if (step > total) return null;
  return { step, total, progress: step / total };
}
