import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { errors } from '../errors.js';
import type { LogBuffer } from '../logs/buffer.js';
import type { BackendManager } from '../backends/manager.js';

/**
 * Text generation as a queued job.
 *
 * The OpenAI-compatible `/v1/llm/*` routes stay straight proxies: they are part
 * of the sd-api contract, and token streaming only works when the bytes go
 * through untouched. This service is the non-streaming path behind the UI, so a
 * completion is a real job — queued, cancellable, retained in history, and
 * counted against `MAX_CONCURRENT_JOBS` like any other generation.
 *
 * Unlike the other kinds the result is not a file. A completion is a few KB of
 * text, so writing it to `OUTPUT_DIR` and handing back a URL would mean the
 * client fetches back something the job already had in hand — and the media
 * library, which is for images, video and audio, would gain entries nothing can
 * play. The text rides in the job result instead.
 */

export interface TextGenerateParams {
  model: string;
  /** Chat-style input. Mutually exclusive with `prompt`. */
  messages?: unknown[];
  /** Completion-style input. */
  prompt?: string;
  [key: string]: unknown;
}

export interface TextGenerateResult {
  text: string;
  /** Upstream token accounting, when llama.cpp reports it. */
  usage?: Record<string, unknown>;
  finishReason?: string;
  durationMs: number;
  params: TextGenerateParams;
}

export interface TextGenerateOptions {
  params: TextGenerateParams;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

interface CompletionResponse {
  choices?: {
    message?: { content?: string };
    text?: string;
    finish_reason?: string;
  }[];
  usage?: Record<string, unknown>;
}

export class TextService {
  constructor(
    private readonly config: Config,
    private readonly backends: BackendManager,
    private readonly log: FastifyBaseLogger,
    private readonly logs: LogBuffer,
  ) {}

  async generate(options: TextGenerateOptions): Promise<TextGenerateResult> {
    const { params, onLog, signal } = options;
    const started = Date.now();

    const process = await this.backends.ensureRunning('llamacpp');
    if (!process) {
      throw errors.backendUnavailable(
        'llamacpp',
        'llamacpp is not running — no text models are installed yet',
      );
    }
    process.markActivity();

    // Chat and completion share this path; which upstream endpoint applies is
    // decided by the shape of the input, the same way the proxy routes split.
    const chat = Array.isArray(params.messages);
    const upstreamPath = chat ? '/v1/chat/completions' : '/v1/completions';

    // `stream` is dropped deliberately: a queued job collects a whole result,
    // and an SSE body here would be parsed as JSON and fail.
    const { stream: _stream, ...rest } = params;
    const body = { ...rest };

    onLog?.(`${chat ? 'chat' : 'completion'}: ${params.model}`);

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      this.config.llamacppTimeoutMs > 0
        ? setTimeout(() => controller.abort(), this.config.llamacppTimeoutMs)
        : null;
    timer?.unref();

    try {
      const response = await fetch(`${this.backends.baseUrl('llamacpp')}${upstreamPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw errors.backendUpstreamError(
          'llamacpp',
          `text generation failed (${response.status}): ${detail.slice(0, 500)}`,
        );
      }

      const payload = (await response.json()) as CompletionResponse;
      const choice = payload.choices?.[0];
      const text = choice?.message?.content ?? choice?.text ?? '';

      const durationMs = Date.now() - started;
      this.log.info({ model: params.model, durationMs, chars: text.length }, 'text generated');
      this.logs.push({
        level: 'info',
        source: 'job',
        msg: `text generated in ${durationMs}ms`,
        fields: { model: params.model, chars: text.length },
      });

      return {
        text,
        usage: payload.usage,
        finishReason: choice?.finish_reason,
        durationMs,
        params,
      };
    } catch (err) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw errors.backendUpstreamError(
          'llamacpp',
          `text generation exceeded LLAMACPP_TIMEOUT (${this.config.llamacppTimeoutMs}ms)`,
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
