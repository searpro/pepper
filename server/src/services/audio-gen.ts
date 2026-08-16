import { writeFile, mkdir } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { Paths } from '../paths.js';
import { safeResolve } from '../paths.js';
import { uniqueOutputName } from '../util/files.js';
import type { BackendManager } from '../backends/manager.js';

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

    const process = await this.backends.ensureRunning('audiocpp');
    if (!process) {
      throw errors.backendUnavailable(
        'audiocpp',
        'audiocpp is not running — no audio models are installed yet',
      );
    }
    process.markActivity();

    const body: Record<string, unknown> = { ...params };
    if (typeof params.voice_ref === 'string') {
      body.voice_ref = await this.resolveVoiceRef(params.voice_ref);
    }

    onLog?.(`speech: ${params.model} (${params.input.length} chars)`);

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
      const response = await fetch(`${this.backends.baseUrl('audiocpp')}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw errors.backendUpstreamError(
          'audiocpp',
          `speech generation failed (${response.status}): ${detail.slice(0, 500)}`,
        );
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        throw errors.backendUpstreamError('audiocpp', 'speech generation returned no audio');
      }

      await mkdir(this.paths.outputDir, { recursive: true });
      const outputName = uniqueOutputName('wav', 'speech');
      const outputPath = safeResolve(this.paths.outputDir, outputName);
      await writeFile(outputPath, audio);

      const durationMs = Date.now() - started;
      this.log.info({ model: params.model, outputName, durationMs }, 'speech generated');
      this.logs.push({
        level: 'info',
        source: 'job',
        msg: `speech generated in ${durationMs}ms`,
        fields: { model: params.model, output: outputName },
      });

      return { outputPath, outputName, durationMs, params };
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw errors.backendUpstreamError(
          'audiocpp',
          `speech generation exceeded AUDIOCPP_TIMEOUT (${this.config.audiocppTimeoutMs}ms)`,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      process.markActivity();
    }
  }
}
