/**
 * The joint master (docs/H3-16GB.md §5): a run of shots that continue each
 * other from their latents is upscaled and re-sampled as one piece, so fine
 * texture is decided across the joins instead of differently on either
 * side, then split back into one master per take so the cut plays them as
 * before.
 *
 * Mastering takes one by one cannot be seamless: a refine re-invents most
 * of the fine texture from its prior and its noise, and two takes refined
 * apart invent it differently at the join (obvpm's measurements, 2026-09).
 */

const FPS = 24;

/** One take in a run, as the run is laid out: its delivered seconds. */
export interface JointPart {
  takeId: string;
  durationS: number;
}

/** Frame ranges `[start, end)` of each take in the joint render. */
export function jointSplits(parts: JointPart[], fps = FPS): { takeId: string; start: number; end: number }[] {
  let at = 0;
  return parts.map((part) => {
    const frames = Math.max(1, Math.round(part.durationS * fps));
    const range = { takeId: part.takeId, start: at, end: at + frames };
    at += frames;
    return range;
  });
}

/**
 * ffmpeg arguments that cut frames `[start, end)` (and the sound under them)
 * out of a joint render, frame-exact: trim filters rather than a seek, which
 * would land on a keyframe. Re-encoded at a high quality, since this is the
 * file that is delivered.
 */
export function jointSplitArgs(input: string, range: { start: number; end: number }, output: string, hasAudio: boolean, fps = FPS): string[] {
  const from = (range.start / fps).toFixed(6);
  const to = (range.end / fps).toFixed(6);
  return [
    '-i',
    input,
    '-vf',
    `trim=start_frame=${range.start}:end_frame=${range.end},setpts=PTS-STARTPTS`,
    ...(hasAudio ? ['-af', `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`, '-c:a', 'aac', '-b:a', '320k'] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '14',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ];
}

/**
 * The run of shots a take belongs to: walking back while a shot continues
 * the one before it, and forward while the next one continues this one.
 * `continuesFrom(i)` says whether shot `i`'s chosen take was continued from
 * shot `i - 1`'s chosen take through their latents.
 */
export function continuityRun(count: number, index: number, continuesFrom: (i: number) => boolean): { first: number; last: number } {
  let first = index;
  while (first > 0 && continuesFrom(first)) first--;
  let last = index;
  while (last + 1 < count && continuesFrom(last + 1)) last++;
  return { first, last };
}
