import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { errors } from '../errors.js';
import { isExecutableAvailable } from './files.js';

/**
 * Audio inspection, slicing and muxing for speech-to-video.
 *
 * A speech-driven video model conditions on a few seconds of audio at a time —
 * the cross-attention context and the VAE's temporal window both cap out well
 * before a sentence does — so anything longer than one window has to be cut
 * into chunks, generated separately and stitched back together. That is the
 * whole reason this module exists.
 *
 * Two backends, deliberately:
 *
 * - **Uncompressed WAV is handled natively.** Slicing PCM is arithmetic on a
 *   byte offset, and making the common case work without a system dependency
 *   means an operator who only ever feeds it WAV never has to install ffmpeg
 *   to use the feature at all.
 * - **Everything else needs ffmpeg**, because decoding MP3 in-process would
 *   mean vendoring a decoder for no benefit. When it is absent the error names
 *   the format and the fix rather than failing somewhere deep in the chunk
 *   loop.
 *
 * Stitching always needs ffmpeg: concatenating encoded video is not something
 * worth reimplementing.
 */

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  /** Total duration in seconds. */
  duration: number;
}

/** A single generated window of the source audio. */
export interface AudioChunk {
  index: number;
  path: string;
  /** Offset into the source audio, in seconds. */
  start: number;
  duration: number;
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export async function ffmpegAvailable(): Promise<boolean> {
  return isExecutableAvailable(FFMPEG);
}

function isWav(path: string): boolean {
  return /\.wav$/i.test(path);
}

/** Run ffmpeg, resolving only on a clean exit. */
export function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (buf: Buffer) => {
      stderr.push(buf.toString());
      // An ffmpeg that is failing repeatedly can produce a lot of output; only
      // the tail is ever shown, so only the tail is worth holding.
      if (stderr.length > 40) stderr.shift();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(errors.generationFailed(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      reject(
        e.code === 'ENOENT'
          ? errors.unsupported(
              `ffmpeg not found (looked for "${FFMPEG}"). Install it, or set FFMPEG_PATH.`,
            )
          : errors.generationFailed(`Failed to start ffmpeg: ${e.message}`),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(
        errors.generationFailed(
          `ffmpeg exited with code ${code ?? 'null'}: ${stderr.join('').trim().slice(0, 500)}`,
        ),
      );
    });
  });
}

// --- Native WAV ------------------------------------------------------------

interface WavLayout extends AudioInfo {
  bytesPerFrame: number;
  dataOffset: number;
  dataLength: number;
  /** The 44-byte canonical header is rebuilt rather than copied. */
  bitsPerSample: number;
}

/**
 * Parse a RIFF/WAVE header by walking its chunks.
 *
 * The naive version assumes `data` starts at byte 44, which is true only for
 * files written by the simplest encoders. Anything that carries a `LIST` info
 * chunk or a `fact` chunk — which includes most real-world recordings and
 * everything ffmpeg produces — puts it somewhere else, and reading from a
 * fixed offset silently slices metadata into the audio as noise.
 */
function parseWav(buffer: Buffer): WavLayout {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw errors.validation('Not a RIFF/WAVE file');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw errors.validation('RIFF file is not WAVE audio');
  }

  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw errors.validation('WAVE file has a data chunk before its fmt chunk');
      // PCM (1) and IEEE float (3) are byte-sliceable; a compressed payload in
      // a WAV container is not, and must go the ffmpeg route instead.
      if (fmt.format !== 1 && fmt.format !== 3) {
        throw errors.validation(`WAVE file uses compressed format ${fmt.format}`);
      }
      const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
      if (bytesPerFrame <= 0) throw errors.validation('WAVE file declares a zero frame size');

      // A truncated recording declares more data than it holds. Trusting the
      // header would slice past the end of the buffer and emit empty chunks.
      const dataLength = Math.min(size, buffer.length - body);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        bytesPerFrame,
        dataOffset: body,
        dataLength,
        duration: dataLength / bytesPerFrame / fmt.sampleRate,
      };
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  throw errors.validation('WAVE file has no data chunk');
}

/** Build a canonical 44-byte PCM header for a slice of sample data. */
function wavHeader(layout: WavLayout, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(layout.bitsPerSample === 32 ? 3 : 1, 20);
  header.writeUInt16LE(layout.channels, 22);
  header.writeUInt32LE(layout.sampleRate, 24);
  header.writeUInt32LE(layout.sampleRate * layout.bytesPerFrame, 28);
  header.writeUInt16LE(layout.bytesPerFrame, 32);
  header.writeUInt16LE(layout.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// --- Public API ------------------------------------------------------------

/** Duration, sample rate and channel count of an audio file. */
export async function probeAudio(path: string): Promise<AudioInfo> {
  if (isWav(path)) {
    try {
      const { sampleRate, channels, duration } = parseWav(await readFile(path));
      return { sampleRate, channels, duration };
    } catch {
      // A .wav that will not parse natively may still be something ffmpeg
      // understands (a compressed payload in a WAV container), so fall through
      // rather than rejecting a file that is actually usable.
    }
  }
  return probeWithFfprobe(path);
}

async function probeWithFfprobe(path: string): Promise<AudioInfo> {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  if (!(await isExecutableAvailable(probe))) {
    throw errors.unsupported(
      `Reading "${basename(path)}" needs ffprobe, which was not found. ` +
        'Install ffmpeg, set FFPROBE_PATH, or supply uncompressed WAV audio.',
    );
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(probe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels:format=duration',
      '-of', 'json',
      path,
    ]);
    const chunks: string[] = [];
    child.stdout?.on('data', (buf: Buffer) => chunks.push(buf.toString()));
    child.on('error', (err) => reject(errors.generationFailed(`ffprobe failed: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve(chunks.join('')) : reject(errors.validation(`ffprobe could not read ${basename(path)}`)),
    );
  });

  const parsed = JSON.parse(output) as {
    streams?: Array<{ sample_rate?: string; channels?: number }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);
  if (!stream || !Number.isFinite(duration)) {
    throw errors.validation(`No audio stream found in ${basename(path)}`);
  }
  return {
    sampleRate: Number(stream.sample_rate) || 16000,
    channels: stream.channels ?? 1,
    duration,
  };
}

export interface SliceOptions {
  sourcePath: string;
  /** Directory the chunks are written into. */
  outDir: string;
  /** Length of each chunk's *new* audio, in seconds. */
  chunkSeconds: number;
  /** How much of the previous chunk each one repeats, in seconds. */
  overlapSeconds: number;
  /** Resample every chunk to this rate. Ignored on the native WAV path. */
  targetSampleRate?: number;
}

/**
 * Cut audio into overlapping chunks.
 *
 * Chunk N starts `overlapSeconds` before chunk N-1 ended, so the model sees
 * the tail of the previous window as context and the seam lands mid-phoneme
 * rather than at a hard cut. The overlap is trimmed back out when the video
 * segments are concatenated.
 */
export async function sliceAudio(options: SliceOptions): Promise<AudioChunk[]> {
  const { sourcePath, outDir, chunkSeconds, overlapSeconds } = options;

  if (chunkSeconds <= 0) throw errors.validation('chunkSeconds must be positive');
  if (overlapSeconds < 0 || overlapSeconds >= chunkSeconds) {
    throw errors.validation('overlapSeconds must be at least 0 and less than chunkSeconds');
  }

  const info = await probeAudio(sourcePath);
  // The step is what advances the timeline; the window is what each chunk
  // actually contains. Confusing the two is what makes stitched output drift
  // steadily out of sync with the speech.
  const step = chunkSeconds - overlapSeconds;
  const count = Math.max(1, Math.ceil((info.duration - overlapSeconds) / step));

  const native = isWav(sourcePath) && !options.targetSampleRate;
  const buffer = native ? await readFile(sourcePath) : null;
  const layout = buffer ? safeParse(buffer) : null;

  const chunks: AudioChunk[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * step;
    const duration = Math.min(chunkSeconds, info.duration - start);
    // A final sliver shorter than a video frame produces a chunk the model
    // cannot condition on; the previous chunk's overlap already covers it.
    if (duration <= 0.05) break;

    const path = join(outDir, `chunk-${String(index).padStart(4, '0')}.wav`);

    if (buffer && layout) {
      const from = layout.dataOffset + alignToFrame(start * layout.sampleRate, layout);
      const to = Math.min(
        layout.dataOffset + layout.dataLength,
        layout.dataOffset + alignToFrame((start + duration) * layout.sampleRate, layout),
      );
      const body = buffer.subarray(from, to);
      await writeFile(path, Buffer.concat([wavHeader(layout, body.length), body]));
    } else {
      await runFfmpeg([
        '-ss', start.toFixed(3),
        '-t', duration.toFixed(3),
        '-i', sourcePath,
        '-vn',
        ...(options.targetSampleRate ? ['-ar', String(options.targetSampleRate)] : []),
        '-c:a', 'pcm_s16le',
        path,
      ]);
    }

    chunks.push({ index, path, start, duration });
  }

  if (chunks.length === 0) throw errors.validation('Audio file contains no usable audio');
  return chunks;
}

function safeParse(buffer: Buffer): WavLayout | null {
  try {
    return parseWav(buffer);
  } catch {
    return null;
  }
}

/** Round a sample offset down to a whole frame boundary. */
function alignToFrame(samples: number, layout: WavLayout): number {
  return Math.floor(samples) * layout.bytesPerFrame;
}

/**
 * Concatenate video segments and mux the original audio over the result.
 *
 * The source audio is used rather than the per-chunk copies because the chunks
 * overlap: re-joining them would repeat `overlapSeconds` of speech at every
 * seam. Re-encoding rather than stream-copying is deliberate too — the
 * segments come out of separate model runs and a concat demuxer copy needs
 * byte-identical encoder settings, which is exactly the assumption that breaks
 * silently in the middle of a long render.
 */
export async function stitchSegments(input: {
  segmentPaths: string[];
  audioPath: string;
  outputPath: string;
  workDir: string;
  /** Seconds of each segment after the first that duplicate the previous one. */
  overlapSeconds: number;
  fps: number;
  timeoutMs?: number;
}): Promise<void> {
  const { segmentPaths, audioPath, outputPath, workDir, overlapSeconds, fps } = input;

  if (segmentPaths.length === 0) throw errors.generationFailed('No video segments to stitch');

  if (!(await ffmpegAvailable())) {
    throw errors.unsupported(
      `Joining ${segmentPaths.length} video segments needs ffmpeg, which was not found ` +
        `(looked for "${FFMPEG}"). Install it, set FFMPEG_PATH, or supply audio short ` +
        'enough to render in a single chunk.',
    );
  }

  // One segment and no seam to hide: mux the audio straight on rather than
  // paying for a concat filter graph.
  if (segmentPaths.length === 1) {
    await runFfmpeg(
      ['-i', segmentPaths[0], '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0',
       '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-c:a', 'libopus', '-shortest', outputPath],
      input.timeoutMs,
    );
    return;
  }

  const args: string[] = [];
  for (const path of segmentPaths) args.push('-i', path);
  args.push('-i', audioPath);

  // Every segment but the first replays `overlapSeconds` of the timeline, so
  // that much is trimmed from its head before the concat.
  const parts: string[] = [];
  const labels: string[] = [];
  segmentPaths.forEach((_, index) => {
    const label = `v${index}`;
    const trim = index === 0 ? '' : `trim=start=${overlapSeconds.toFixed(3)},setpts=PTS-STARTPTS,`;
    parts.push(`[${index}:v]${trim}fps=${fps},setpts=PTS-STARTPTS[${label}]`);
    labels.push(`[${label}]`);
  });
  parts.push(`${labels.join('')}concat=n=${segmentPaths.length}:v=1:a=0[outv]`);

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[outv]',
    '-map', `${segmentPaths.length}:a:0`,
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30',
    '-c:a', 'libopus',
    '-shortest',
    outputPath,
  );

  await runFfmpeg(args, input.timeoutMs ?? 600_000);
  void workDir;
}

/**
 * Write the last frame of a video out as a PNG.
 *
 * This is what carries a subject's identity across a seam: the frame becomes
 * the next chunk's conditioning image, so the face the model just drew is the
 * face it starts the next window from. Seeking from the end (`-sseof`) rather
 * than computing a timestamp avoids having to know the duration, and matters
 * for the last chunk, which is usually shorter than the rest.
 */
export async function extractLastFrame(
  videoPath: string,
  outputPath: string,
  timeoutMs = 60_000,
): Promise<void> {
  if (!(await ffmpegAvailable())) {
    throw errors.unsupported(
      `Chaining speech-to-video chunks needs ffmpeg, which was not found (looked for "${FFMPEG}").`,
    );
  }
  await runFfmpeg(
    ['-sseof', '-1', '-i', videoPath, '-update', '1', '-q:v', '2', '-frames:v', '1', outputPath],
    timeoutMs,
  );
}
