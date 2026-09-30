import { randomInt } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { errors } from '../core/errors.js';
import type { LogBuffer } from '../core/logs/buffer.js';
import type { Paths } from '../paths.js';
import { safeResolve } from '../paths.js';
import { uniqueOutputName } from '../core/util/files.js';
import type { BackendManager } from '../core/backends/manager.js';

/**
 * Speech generation as a queued job.
 *
 * The OpenAI-compatible `POST /v1/audio/speech` route stays a straight proxy —
 * it is part of the sd-api contract and returns the audio bytes inline, which
 * streaming clients depend on. This service is the other path: it performs the
 * same request, writes the result to `OUTPUT_DIR`, and hands back a URL, so a
 * generation started from the UI is a real job with progress, cancellation,
 * history and a concurrency slot like every other kind.
 *
 * audio.cpp holds a whole model in memory per request, which is exactly what
 * `MAX_CONCURRENT_JOBS` exists to bound — running speech outside the queue
 * meant that budget only ever applied to images.
 */

export interface AudioGenerateParams {
  model: string;
  input: string;
  /** A configured preset name, or a model-native built-in speaker id. */
  voice?: string;
  /** Name of an uploaded reference clip, for cloning. */
  voice_ref?: string;
  /**
   * Voice direction. Required by voice-design (`vdes`) models, which synthesise
   * a speaker from this description rather than from a reference clip.
   */
  instructions?: string;
  [key: string]: unknown;
}

export interface MusicGenerateParams {
  model: string;
  /** Style, genre, instruments and mood: ACE-Step's caption, HeartMuLa's tags. */
  prompt: string;
  /** Song lyrics with [Verse]/[Chorus] section markers; omit for instrumental. */
  lyrics?: string;
  /** Target length; ACE-Step plans its own length when omitted. */
  duration_seconds?: number;
  steps?: number;
  seed?: number;
  /** ACE-Step route (text2music by default; cover/repaint/… need source audio). */
  task_route?: string;
}

export interface MusicGenerateOptions {
  params: MusicGenerateParams;
  /** The bundle's audio.cpp family, which decides the request's field names. */
  family?: string;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * audio.cpp's request for a music job. The families disagree on names:
 * ACE-Step and Stable Audio read the style from `text` and the length from
 * `duration_seconds`; HeartMuLa reads style from the `tags` option and length
 * from `duration_sec`, and rejects a request that carries both spellings.
 */
export function musicRequest(params: MusicGenerateParams, family?: string): Record<string, unknown> {
  const common = {
    text: params.prompt,
    ...(params.lyrics ? { lyrics: params.lyrics } : {}),
    ...(params.steps !== undefined ? { num_inference_steps: params.steps } : {}),
    ...(params.seed !== undefined && params.seed >= 0 ? { seed: params.seed } : {}),
  };
  if (family === 'heartmula') {
    return {
      ...common,
      options: {
        tags: params.prompt,
        ...(params.duration_seconds !== undefined ? { duration_sec: String(params.duration_seconds) } : {}),
      },
    };
  }
  return {
    ...common,
    ...(params.duration_seconds !== undefined ? { duration_seconds: params.duration_seconds } : {}),
    ...(params.task_route ? { task_route: params.task_route } : {}),
  };
}

export interface AudioGenerateResult {
  outputPath: string;
  outputName: string;
  durationMs: number;
  params: AudioGenerateParams;
}

export interface AudioGenerateOptions {
  params: AudioGenerateParams;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export class AudioService {
  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly backends: BackendManager,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {}

  /** Resolve an uploaded reference clip the same way the proxy route does. */
  private async resolveVoiceRef(name: string): Promise<string> {
    const { stat } = await import('node:fs/promises');
    const path = safeResolve(this.paths.uploadsDir, name);
    try {
      await stat(path);
    } catch {
      throw errors.audioVoiceRefNotFound(name);
    }
    return path;
  }

  async generate(options: AudioGenerateOptions): Promise<AudioGenerateResult> {
    const { params, onLog, signal } = options;
    const started = Date.now();

    // Resolved before the backend is started, so a bad reference fails fast
    // and cannot leave a lease held on a backend nobody is using.
    const body: Record<string, unknown> = { ...params };
    if (typeof params.voice_ref === 'string') {
      body.voice_ref = await this.resolveVoiceRef(params.voice_ref);
    }

    onLog?.(`speech: ${params.model} (${params.input.length} chars)`);
    const audio = await this.callAudioCpp('speech', '/v1/audio/speech', body, signal, async (response) =>
      Buffer.from(await response.arrayBuffer()),
    );
    return this.save('speech', audio, params, started);
  }

  /**
   * Music through audio.cpp's generic task route (`task: gen`), which is how
   * its music families — ACE-Step 1.5, HeartMuLa, Stable Audio 3 — are driven.
   * The WAV comes back base64-encoded inside the JSON result.
   */
  async generateMusic(options: MusicGenerateOptions): Promise<AudioGenerateResult> {
    const { onLog, signal } = options;
    const started = Date.now();
    // audio.cpp falls back to a fixed seed, which would make every song from
    // the same prompt identical; resolve one here and record it instead.
    const params: MusicGenerateParams = {
      ...options.params,
      seed:
        options.params.seed !== undefined && options.params.seed >= 0
          ? options.params.seed
          : randomInt(0, 2 ** 31 - 1),
    };
    const request = musicRequest(params, options.family);

    onLog?.(
      `music: ${params.model}` +
        (params.duration_seconds ? ` (${params.duration_seconds}s)` : '') +
        (params.lyrics ? `, ${params.lyrics.length} chars of lyrics` : ', instrumental'),
    );
    const audio = await this.callAudioCpp(
      'music generation',
      '/v1/tasks/run',
      // A song can take minutes; audio.cpp's own per-request lock wait is
      // shorter than that by default, so ask it to wait as long as we will.
      { model: params.model, request, busy_timeout_ms: this.config.audiocppTimeoutMs || undefined },
      signal,
      async (response) => {
        const result = (await response.json()) as { audio?: string };
        return result.audio ? Buffer.from(result.audio, 'base64') : Buffer.alloc(0);
      },
    );
    return this.save('music', audio, params as unknown as AudioGenerateParams, started);
  }

  /**
   * One request to audio.cpp: hold a lease on the backend, share the job's
   * abort signal with the configured ceiling, and turn failures into
   * upstream errors naming what was being done.
   */
  private async callAudioCpp(
    what: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    read: (response: Response) => Promise<Buffer>,
  ): Promise<Buffer> {
    const lease = await this.backends.acquire('audiocpp');
    if (!lease) {
      throw errors.backendUnavailable(
        'audiocpp',
        'audiocpp is not running — no audio models are installed yet',
      );
    }
    const { release } = lease;

    // The job's abort signal and the configured ceiling share one controller,
    // so cancelling a job actually stops the upstream request rather than
    // leaving audio.cpp busy with work nobody is waiting for.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      this.config.audiocppTimeoutMs > 0
        ? setTimeout(() => controller.abort(), this.config.audiocppTimeoutMs)
        : null;
    timer?.unref();

    try {
      const response = await fetch(`${this.backends.baseUrl('audiocpp')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw errors.backendUpstreamError(
          'audiocpp',
          `${what} failed (${response.status}): ${detail.slice(0, 500)}`,
        );
      }
      const audio = await read(response);
      if (audio.length === 0) {
        throw errors.backendUpstreamError('audiocpp', `${what} returned no audio`);
      }
      return audio;
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw errors.backendUpstreamError(
          'audiocpp',
          `${what} exceeded AUDIOCPP_TIMEOUT (${this.config.audiocppTimeoutMs}ms)`,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  private async save(
    kind: 'speech' | 'music',
    audio: Buffer,
    params: AudioGenerateParams,
    started: number,
  ): Promise<AudioGenerateResult> {
    await mkdir(this.paths.outputDir, { recursive: true });
    const outputName = uniqueOutputName('wav', kind);
    const outputPath = safeResolve(this.paths.outputDir, outputName);
    await writeFile(outputPath, audio);

    const durationMs = Date.now() - started;
    this.log.info({ model: params.model, outputName, durationMs }, `${kind} generated`);
    this.logs.push({
      level: 'info',
      source: 'job',
      msg: `${kind} generated in ${durationMs}ms`,
      fields: { model: params.model, output: outputName },
    });
    return { outputPath, outputName, durationMs, params };
  }
}
