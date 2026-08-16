import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { errors } from '../errors.js';
import type { StepProgress } from '../logs/parse.js';
import { alignFrames, type ResolvedImageBundle } from '../models/bundle.js';
import type { GenerateParams } from '../schemas/generate.js';
import {
  extractLastFrame,
  probeAudio,
  sliceAudio,
  stitchSegments,
  type AudioChunk,
} from '../util/ffmpeg.js';

/**
 * Speech-to-video orchestration.
 *
 * A speech-driven video model can only condition on a few seconds of audio at
 * a time. Both limits are hard: the audio cross-attention context is sized for
 * one window, and decoding the whole timeline's latents through the VAE at
 * once scales memory superlinearly — a three-minute clip asks for hundreds of
 * gigabytes and gets OOM-killed. So a long recording is not one long
 * generation, it is many short ones played back to back.
 *
 * Three things make that produce a video rather than a slideshow:
 *
 * 1. **Chunks overlap.** Each window replays the tail of the previous one, so
 *    the model has run-up context and the seam falls mid-phoneme. The overlap
 *    is trimmed back out at stitch time.
 * 2. **Frames chain.** The final frame of chunk N seeds chunk N+1 as its
 *    conditioning image, which is what stops the subject being re-imagined
 *    with a different face every five seconds.
 * 3. **The original audio is muxed back on**, not the chunks. Re-joining the
 *    chunks would repeat the overlap at every seam and drift out of sync.
 *
 * This sits beside `ImageService` rather than inside it because it is a
 * different shape of work: not one spawn, but a supervised loop over many,
 * with filesystem state between them.
 */

/** Runs one chunk. Supplied by `ImageService`, which owns spawning sd-cli. */
export type ChunkRunner = (input: {
  params: GenerateParams;
  audioPath: string;
  initImagePath?: string;
  /** Flag the conditioning image is passed under, from `s2v.chain_flag`. */
  initImageFlag?: string;
  outputPath: string;
  onProgress?: (progress: StepProgress) => void;
}) => Promise<void>;

export interface S2vOptions {
  params: GenerateParams;
  bundle: ResolvedImageBundle;
  /** Absolute path to the uploaded speech file. */
  audioPath: string;
  /** Where the finished video is written. */
  outputPath: string;
  /** The user's conditioning image, used for the first chunk. */
  initImagePath?: string;
  runChunk: ChunkRunner;
  timeoutMs: number;
  log: FastifyBaseLogger;
  onProgress?: (progress: StepProgress) => void;
  signal?: AbortSignal;
}

export interface S2vResult {
  audioDurationSeconds: number;
  chunks: number;
  framesPerChunk: number;
  fps: number;
}

export async function generateSpeechVideo(options: S2vOptions): Promise<S2vResult> {
  const { params, bundle, audioPath, outputPath, runChunk, log, signal } = options;

  const config = bundle.s2v;
  if (!config) {
    throw errors.unsupported(
      `Model "${bundle.id}" does not declare the "s2v" capability, so it cannot generate ` +
        'from speech. Install a speech-to-video model, or drop the audio input.',
    );
  }

  const chunkSeconds = params.audio_chunk_seconds ?? config.chunkSeconds;
  const overlapSeconds = params.audio_overlap_seconds ?? config.overlapSeconds;
  if (overlapSeconds >= chunkSeconds) {
    throw errors.validation('audio_overlap_seconds must be less than audio_chunk_seconds');
  }

  const info = await probeAudio(audioPath);
  // fps is what ties the frame budget to the wall clock. Deriving it from the
  // model's own window keeps a chunk's video exactly as long as its audio; a
  // mismatch here is what makes lip-sync drift a little further at every seam.
  const fps = params.fps ?? bundle.defaults.fps ?? Math.round(config.framesPerChunk / chunkSeconds);

  const workDir = await mkdtemp(join(tmpdir(), 'pepper-s2v-'));

  try {
    const chunks = await sliceAudio({
      sourcePath: audioPath,
      outDir: workDir,
      chunkSeconds,
      overlapSeconds,
      targetSampleRate: config.sampleRate,
    });

    log.info(
      {
        model: bundle.id,
        audioSeconds: Number(info.duration.toFixed(2)),
        chunks: chunks.length,
        chunkSeconds,
        overlapSeconds,
        fps,
      },
      'speech-to-video: sliced audio',
    );

    const segments = await renderChunks({
      chunks,
      config,
      params,
      fps,
      workDir,
      runChunk,
      initImagePath: options.initImagePath,
      onProgress: options.onProgress,
      signal,
      log,
    });

    await stitchSegments({
      segmentPaths: segments,
      audioPath,
      outputPath,
      workDir,
      overlapSeconds,
      fps,
      timeoutMs: options.timeoutMs,
    });

    return {
      audioDurationSeconds: info.duration,
      chunks: chunks.length,
      framesPerChunk: config.framesPerChunk,
      fps,
    };
  } finally {
    // The intermediates are large — a per-chunk video plus a PNG each — and
    // nothing downstream reads them once the result exists.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderChunks(input: {
  chunks: AudioChunk[];
  config: NonNullable<ResolvedImageBundle['s2v']>;
  params: GenerateParams;
  fps: number;
  workDir: string;
  runChunk: ChunkRunner;
  initImagePath?: string;
  onProgress?: (progress: StepProgress) => void;
  signal?: AbortSignal;
  log: FastifyBaseLogger;
}): Promise<string[]> {
  const { chunks, config, params, fps, workDir, runChunk, log, signal } = input;

  const segments: string[] = [];
  let conditioningImage = input.initImagePath;

  for (const chunk of chunks) {
    // Cancellation has to be checked between chunks as well as inside them:
    // aborting during chunk 3 of 40 must not let chunk 4 start.
    if (signal?.aborted) throw errors.generationFailed('Generation cancelled');

    const segmentPath = join(workDir, `segment-${String(chunk.index).padStart(4, '0')}.webm`);

    // The last chunk is usually short. Asking for a full window of frames
    // would pad it with video the audio does not cover, which shows up as a
    // frozen tail after the speech ends.
    //
    // The grid alignment is not cosmetic: a model that rounds the count up
    // itself (MiniMax-H3's 17k+5) would hand back a segment slightly longer
    // than the audio it covers, and the error compounds at every seam. Doing
    // the rounding here means the stitch knows the real length.
    const frames = alignFrames(
      Math.max(1, Math.min(config.framesPerChunk, Math.round(chunk.duration * fps))),
      config.frameGrid,
    );

    log.info(
      { chunk: chunk.index + 1, of: chunks.length, frames, chained: Boolean(conditioningImage) },
      'speech-to-video: rendering chunk',
    );

    await runChunk({
      params: { ...params, video_frames: frames, fps },
      audioPath: chunk.path,
      initImagePath: conditioningImage,
      initImageFlag: chunk.index === 0 ? undefined : config.chainFlag,
      outputPath: segmentPath,
      // Per-chunk step progress is rescaled into this chunk's slice of the
      // whole run, so the UI shows one bar advancing to 100% rather than
      // forty bars each restarting from zero.
      onProgress: (progress) =>
        input.onProgress?.({
          ...progress,
          progress: (chunk.index + progress.progress) / chunks.length,
        }),
    });

    segments.push(segmentPath);

    if (config.chainFrames && chunk.index < chunks.length - 1) {
      const framePath = join(workDir, `seed-${String(chunk.index).padStart(4, '0')}.png`);
      try {
        await extractLastFrame(segmentPath, framePath);
        conditioningImage = framePath;
      } catch (err) {
        // A failed extraction degrades continuity but does not invalidate the
        // frames already rendered, so the run continues from the previous
        // conditioning image rather than discarding minutes of GPU time.
        log.warn(
          { chunk: chunk.index, err: (err as Error).message },
          'speech-to-video: could not chain frame, continuing without it',
        );
      }
    }
  }

  return segments;
}
