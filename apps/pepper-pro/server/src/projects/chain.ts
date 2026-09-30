/**
 * Long takes and retakes (docs/PEPPER-PRO.md §6.3): a clip longer than a
 * recipe renders at once is rendered as segments, each continuing the last
 * through the recipe's `continuation` input, and cut together with the
 * repeated overlap trimmed. A retake of part of a take is the same chain
 * started from the kept head of the original.
 *
 * The chain is driven by the project service, one segment job at a time,
 * rather than by a parent job: a job that waited on its children would hold
 * the only job slot they need.
 */

export interface ChainSegment {
  /** Seconds this segment renders, the repeated overlap included. */
  duration: number;
  jobId?: string;
  /** The segment's output, copied into uploads so the next can continue it. */
  upload?: string;
}

export interface TakeChain {
  /** `long`: the shot is longer than one render. `retake`: a take re-rendered from `from` seconds on. */
  kind: 'long' | 'retake';
  /** The recipe's continuation input and duration input. */
  param: string;
  durationParam: string;
  overlapS: number;
  /** Seconds the joined take lasts. */
  total: number;
  /** The parameters every continuing segment is rendered with. */
  next: Record<string, unknown>;
  /** Parameters only the last segment gets (its last frame). */
  last: Record<string, unknown>;
  /** A retake's kept opening (an upload), which the first segment continues. */
  head?: string;
  from?: number;
  sourceTakeId?: string;
  segments: ChainSegment[];
  /** The segment rendering now. */
  index: number;
  state: 'rendering' | 'joining' | 'done' | 'failed';
  error?: string;
}

/** Past this many segments a take drifts too far from its prompt to be worth the render. */
export const MAX_SEGMENTS = 12;

/**
 * Split `seconds` of new footage into segment lengths of at most `max`.
 * Every segment that continues another (all but the first, or all of them
 * when `continuing` a retake's head) repeats `overlap` seconds, so it renders
 * that much more than it adds. A segment shorter than `min` is lengthened;
 * the join cuts the take back to its length.
 */
export function planSegments(seconds: number, limits: { max: number; min?: number; overlap: number; continuing?: boolean }): number[] {
  const { max, overlap } = limits;
  const min = limits.min ?? 0;
  if (max - overlap < 1) throw new Error(`segments of ${max} s cannot continue with ${overlap} s of overlap`);
  const out: number[] = [];
  let left = seconds;
  let continuing = Boolean(limits.continuing);
  while (left > 0.05) {
    const repeat = continuing ? overlap : 0;
    const duration = Math.max(min, Math.min(max, left + repeat));
    out.push(round(duration));
    left -= duration - repeat;
    continuing = true;
    if (out.length > MAX_SEGMENTS) throw new Error(`${seconds} s needs more than ${MAX_SEGMENTS} segments of ${max} s`);
  }
  return out;
}

export interface JoinPart {
  path: string;
  /** Seconds trimmed from the head (a continuation's overlap). */
  start?: number;
  /** Where to stop, in the part's own seconds (a retake's head). */
  end?: number;
}

/**
 * ffmpeg arguments that trim and concatenate the parts, re-encoded because
 * the parts come from separate renders (see stitchSegments in core). Audio
 * is kept when every part has it: H3 renders the soundtrack with the
 * picture, so each segment's sound is cut at the same seam as its frames.
 */
export function joinArgs(parts: JoinPart[], options: { audio: boolean; total: number; fps: number; output: string }): string[] {
  const args: string[] = [];
  for (const part of parts) args.push('-i', part.path);
  const filters: string[] = [];
  const labels: string[] = [];
  parts.forEach((part, i) => {
    const range = [part.start ? `start=${part.start.toFixed(3)}` : '', part.end !== undefined ? `end=${part.end.toFixed(3)}` : '']
      .filter(Boolean)
      .join(':');
    filters.push(`[${i}:v]${range ? `trim=${range},` : ''}setpts=PTS-STARTPTS,fps=${options.fps},format=yuv420p[v${i}]`);
    labels.push(`[v${i}]`);
    if (options.audio) {
      filters.push(`[${i}:a]${range ? `atrim=${range},` : ''}asetpts=PTS-STARTPTS,aresample=48000[a${i}]`);
      labels.push(`[a${i}]`);
    }
  });
  filters.push(`${labels.join('')}concat=n=${parts.length}:v=1:a=${options.audio ? 1 : 0}${options.audio ? '[v][a]' : '[v]'}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (options.audio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-t', options.total.toFixed(3), '-movflags', '+faststart', options.output);
  return args;
}

function round(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}
