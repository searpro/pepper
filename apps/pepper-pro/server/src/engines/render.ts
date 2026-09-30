import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Engine } from '@pepper/core/engines/engine.js';
import { errors } from '@pepper/core/errors.js';
import type { JobContext, JobExecutor } from '@pepper/core/jobs/manager.js';
import { safeResolve } from '@pepper/core/paths.js';
import { probeMedia, runFfmpegTracked, type MediaInfo } from '@pepper/core/util/ffmpeg.js';
import { uniqueOutputName } from '@pepper/core/util/files.js';
import type { ProPaths } from '../paths.js';
import type { ProjectService } from '../projects/service.js';

/**
 * Assembling a cut (docs/PEPPER-PRO.md §8): the chosen takes trimmed and
 * conformed to the project's frame, joined with cuts or crossfades, a music
 * bed ducked under the dialogue, the project LUT, loudness normalised for
 * social (−14 LUFS), subtitles burned in when asked and always written as a
 * sidecar. One ffmpeg run, so a cut is one job with one progress bar.
 *
 * The polish is deliberate: a single LUT over every shot hides the colour
 * drift between generations, and the crossfaded audio hides the joins — the
 * two things that most make an AI edit look stitched together.
 */

export interface RenderEngineDeps {
  paths: ProPaths;
  projects: ProjectService;
  log: FastifyBaseLogger;
}

interface CutItem {
  take_id: string;
  /** Seconds into the take. */
  in?: number;
  out?: number;
  /** How this item joins the one before it. */
  transition?: 'cut' | 'fade';
}

interface MusicBed {
  asset_id: string;
  gain_db?: number;
  /** Lower the music while people speak. */
  duck?: boolean;
}

const FADE_S = 0.5;
const STILL_S = 3;

/** The delivery frame for an aspect: 1080 on the short side. */
export function frameFor(aspect: string): { width: number; height: number } {
  const frames: Record<string, [number, number]> = {
    '9:16': [1080, 1920],
    '16:9': [1920, 1080],
    '1:1': [1080, 1080],
    '4:5': [1080, 1350],
    '4:3': [1440, 1080],
    '3:4': [1080, 1440],
    '21:9': [2520, 1080],
  };
  const [width, height] = frames[aspect] ?? frames['9:16'];
  return { width, height };
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export interface Segment {
  path: string;
  info: MediaInfo;
  start: number;
  duration: number;
  transition: 'cut' | 'fade';
  lines: string[];
}

/**
 * The ffmpeg arguments for a cut. Separate from running them so the filter
 * graph — the part most likely to be wrong — is testable without encoding.
 */
/** loudnorm's first-pass measurement, fed back into the second pass. */
export interface LoudnessMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

const LOUDNORM = 'I=-14:TP=-1.5:LRA=11';

/**
 * Social loudness (−14 LUFS) in two passes, as loudnorm is meant to be used:
 * `measure` runs the audio alone and prints the measurement; the real pass
 * applies it as a linear gain. Silence measures as −inf, and normalising it
 * turns into NaN in the encoder, so a silent cut is left as it is.
 */
export type Loudness = { measure: true } | { measured: LoudnessMeasure } | { silent: true };

export function parseLoudness(log: string): LoudnessMeasure | null {
  const match = /\{\s*"input_i"[\s\S]*?\}/.exec(log);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as LoudnessMeasure;
  } catch {
    return null;
  }
}

export function isSilent(measure: LoudnessMeasure | null): boolean {
  const level = Number(measure?.input_i);
  return !measure || !Number.isFinite(level) || level < -70;
}

export function buildCutArgs(input: {
  segments: Segment[];
  width: number;
  height: number;
  fps: number;
  music?: { path: string; gainDb: number; duck: boolean };
  lut?: string;
  subtitles?: string;
  output: string;
  loudness?: Loudness;
}): { args: string[]; duration: number } {
  const measuring = input.loudness && 'measure' in input.loudness;
  const { segments, width, height, fps } = input;
  const args: string[] = [];
  const filters: string[] = [];

  segments.forEach((segment, i) => {
    if (segment.info.still) args.push('-loop', '1', '-t', String(segment.duration), '-i', segment.path);
    else args.push('-ss', String(segment.start), '-t', String(segment.duration), '-i', segment.path);
  });
  // Silence for segments with no soundtrack, so every segment has audio and
  // the joins are uniform.
  const silenceIndex = segments.length;
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  let musicIndex = -1;
  if (input.music) {
    musicIndex = silenceIndex + 1;
    args.push('-stream_loop', '-1', '-i', input.music.path);
  }

  segments.forEach((segment, i) => {
    if (!measuring) filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,` +
        `trim=duration=${segment.duration},setpts=PTS-STARTPTS[v${i}]`,
    );
    const audioSource = segment.info.hasAudio && !segment.info.still ? `[${i}:a]` : `[${silenceIndex}:a]`;
    filters.push(
      `${audioSource}aresample=48000,aformat=channel_layouts=stereo,` +
        `atrim=duration=${segment.duration},asetpts=PTS-STARTPTS,apad=whole_dur=${segment.duration}[a${i}]`,
    );
  });

  // Join left to right; a fade overlaps the two segments by FADE_S.
  let video = 'v0';
  let audio = 'a0';
  let total = segments[0].duration;
  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const fade = next.transition === 'fade' && total > FADE_S && next.duration > FADE_S;
    if (fade) {
      if (!measuring) {
        filters.push(`[${video}][v${i}]xfade=transition=fade:duration=${FADE_S}:offset=${(total - FADE_S).toFixed(3)}[vj${i}]`);
      }
      filters.push(`[${audio}][a${i}]acrossfade=d=${FADE_S}[aj${i}]`);
      total += next.duration - FADE_S;
    } else if (measuring) {
      filters.push(`[${audio}][a${i}]concat=n=2:v=0:a=1[aj${i}]`);
      total += next.duration;
    } else {
      filters.push(`[${video}][${audio}][v${i}][a${i}]concat=n=2:v=1:a=1[vj${i}][aj${i}]`);
      total += next.duration;
    }
    video = `vj${i}`;
    audio = `aj${i}`;
  }

  if (input.lut && !measuring) {
    filters.push(`[${video}]lut3d=file='${escapeFilterPath(input.lut)}'[vl]`);
    video = 'vl';
  }
  if (input.subtitles && !measuring) {
    filters.push(`[${video}]subtitles='${escapeFilterPath(input.subtitles)}':force_style='FontSize=18,Outline=2,MarginV=60'[vs]`);
    video = 'vs';
  }

  if (input.music && musicIndex >= 0) {
    filters.push(
      `[${musicIndex}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total.toFixed(3)},` +
        `volume=${input.music.gainDb}dB[mus]`,
    );
    if (input.music.duck) {
      filters.push(`[${audio}]asplit=2[dlg][side]`);
      filters.push(`[mus][side]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
      filters.push(`[dlg][duck]amix=inputs=2:duration=first:normalize=0[mix]`);
    } else {
      filters.push(`[${audio}][mus]amix=inputs=2:duration=first:normalize=0[mix]`);
    }
    audio = 'mix';
  }
  const loudness = input.loudness;
  if (loudness && 'measure' in loudness) {
    filters.push(`[${audio}]loudnorm=${LOUDNORM}:print_format=json[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-t', total.toFixed(3), '-f', 'null', '-');
    return { args, duration: total };
  }
  if (loudness && 'measured' in loudness) {
    const m = loudness.measured;
    filters.push(
      `[${audio}]loudnorm=${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
        `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000[aout]`,
    );
  } else {
    filters.push(`[${audio}]anull[aout]`);
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${video}]`,
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-t',
    total.toFixed(3),
    input.output,
  );
  return { args, duration: total };
}

/** Quote a path for use inside an ffmpeg filter argument. */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Subtitles for a cut: each segment's dialogue lines spread across its time on screen. */
export function buildSrt(segments: Segment[]): string {
  const entries: string[] = [];
  let at = 0;
  let index = 1;
  segments.forEach((segment, i) => {
    const start = i > 0 && segment.transition === 'fade' ? at - FADE_S : at;
    const lines = segment.lines.filter((l) => l.trim());
    const each = lines.length ? segment.duration / lines.length : 0;
    lines.forEach((line, n) => {
      entries.push(`${index++}\n${srtTime(start + n * each)} --> ${srtTime(start + (n + 1) * each - 0.05)}\n${line}\n`);
    });
    at = start + segment.duration;
  });
  return entries.join('\n');
}

export class RenderEngine implements Engine {
  readonly id = 'render';
  readonly label = 'ffmpeg (cuts)';

  constructor(private readonly deps: RenderEngineDeps) {}

  executors(): Partial<Record<'render', JobExecutor>> {
    return { render: (context) => this.render(context) };
  }

  resident(): boolean {
    return false;
  }

  private async render(context: JobContext): Promise<Record<string, unknown>> {
    const started = Date.now();
    const { projects, paths } = this.deps;
    const { cut_id } = context.job.params as { cut_id: string };
    const cut = projects.requireCut(cut_id);
    const project = projects.requireProject(cut.projectId);
    const assets = projects.listAssets(project.id);
    const { width, height } = frameFor(project.aspect);

    const segments: Segment[] = [];
    for (const item of cut.items as CutItem[]) {
      const take = projects.requireTake(item.take_id);
      if (!take.file) throw errors.validation(`Take ${take.id} has no finished file yet`);
      const path = projects.takeFile(project.id, take.file);
      const info = await probeMedia(path);
      const available = info.still ? STILL_S : info.duration;
      const start = Math.max(0, Math.min(item.in ?? 0, available));
      const end = Math.min(item.out ?? available, info.still ? (item.out ?? STILL_S) : available);
      if (end - start < 0.1) throw errors.validation(`Take ${take.id} is trimmed to nothing`);
      const shot = projects.requireShot(take.shotId);
      segments.push({
        path,
        info,
        start,
        duration: end - start,
        transition: item.transition ?? 'cut',
        lines: (shot.dialogue as { line: string }[]).map((d) => d.line),
      });
    }
    if (segments.length === 0) throw errors.validation('This cut has no takes in it');

    const workDir = join(paths.cacheDir, 'render', context.job.id);
    await mkdir(workDir, { recursive: true });
    const srt = buildSrt(segments);
    const srtPath = join(workDir, 'subtitles.srt');
    await writeFile(srtPath, srt);

    const bed = cut.music as MusicBed | null;
    let music: { path: string; gainDb: number; duck: boolean } | undefined;
    if (bed) {
      const asset = assets.find((a) => a.id === bed.asset_id);
      if (!asset?.audio) throw errors.validation('The music bed asset has no audio file');
      music = { path: safeResolve(paths.uploadsDir, asset.audio), gainDb: bed.gain_db ?? -14, duck: bed.duck ?? true };
    }

    const outputName = uniqueOutputName('mp4', 'cut');
    const output = safeResolve(paths.outputDir, outputName);
    await mkdir(dirname(output), { recursive: true });
    const base = {
      segments,
      width,
      height,
      fps: project.fps,
      music,
      lut: project.lut ? safeResolve(paths.uploadsDir, project.lut) : undefined,
      subtitles: cut.subtitles && srt ? srtPath : undefined,
      output,
    };
    const report = (from: number, span: number) => (fraction: number) => {
      const progress = from + fraction * span;
      context.onProgress({ step: Math.round(progress * 100), total: 100, progress });
    };

    // Pass 1: measure the mixed audio's loudness (audio only, so it is quick).
    const measurePass = buildCutArgs({ ...base, loudness: { measure: true } });
    const measured = parseLoudness(
      await runFfmpegTracked(measurePass.args, {
        totalSeconds: measurePass.duration,
        signal: context.signal,
        logLevel: 'info',
        onProgress: report(0, 0.1),
      }),
    );
    const silent = isSilent(measured);
    context.onLog(silent ? 'The cut is silent; leaving its level alone' : `Measured ${measured!.input_i} LUFS; normalising to -14`);

    // Pass 2: everything, with the measurement applied as a linear gain.
    const { args, duration } = buildCutArgs({ ...base, loudness: silent ? { silent: true } : { measured: measured! } });
    context.onLog(`Assembling ${segments.length} takes into ${width}×${height} at ${project.fps} fps (${duration.toFixed(1)} s)`);
    await runFfmpegTracked(args, { totalSeconds: duration, signal: context.signal, onProgress: report(0.1, 0.9) });

    // Keep the export and its subtitles in the project, beside the takes.
    const kept = `${cut.id}-${Date.now()}.mp4`;
    await mkdir(dirname(projects.takeFile(project.id, kept)), { recursive: true });
    await copyFile(output, projects.takeFile(project.id, kept));
    await copyFile(srtPath, projects.takeFile(project.id, kept.replace(/\.mp4$/, '.srt')));

    return {
      video_url: `/v1/outputs/${encodeURIComponent(outputName)}`,
      video_path: output,
      metadata: {
        kind: 'video',
        task: 'cut',
        cut_id: cut.id,
        project_id: project.id,
        width,
        height,
        fps: project.fps,
        duration_s: duration,
        takes: segments.length,
        project_file: kept,
        subtitles_file: kept.replace(/\.mp4$/, '.srt'),
        duration_ms: Date.now() - started,
        output_dir: paths.outputDir,
      },
    };
  }
}
