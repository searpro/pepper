import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { signMediaUrl } from '../core/auth.js';
import { safeResolve } from '../paths.js';
import { contentType } from '../routes/media.js';
import { uniqueOutputName } from '../core/util/files.js';
import { ffmpegAvailable, runFfmpeg } from '../core/util/ffmpeg.js';
import type { Job } from '../core/jobs/manager.js';
import { MEDIA_VIEW_HTML, MEDIA_VIEW_MIME, MEDIA_VIEW_URI, mediaViewMeta } from '../core/mcp/media-view.js';

/**
 * The tools Pepper exposes over MCP (see routes/mcp.ts for the transport).
 *
 * Every tool is a thin wrapper over the HTTP API, called in-process through
 * `app.inject`, rather than over the services directly. That keeps one
 * definition of validation, defaults and error codes: a tool can never accept
 * something the API would reject, or behave differently from the web app.
 *
 * Tools are few and coarse on purpose. Each description is loaded into the
 * context of every conversation the connector is enabled in, and a model
 * picks between ten well-described tools far more reliably than between the
 * API's sixty routes.
 *
 * Long work is submit-then-poll. The tunnel in front of a Kaggle deployment
 * drops any request that runs past 100 seconds, and MCP clients time tool
 * calls out well before a video finishes, so no tool waits longer than
 * `MAX_WAIT_S`; past that the caller gets a job id for `get_job`.
 *
 * Results are shown, not just linked. The tools that produce media name a UI
 * resource (mcp/media-view.ts) that a host supporting MCP Apps renders in the
 * chat: the image, a player, or a progress bar that follows the job. What the
 * model reads (`content`) and what the view draws (`structuredContent`) are
 * built from the same job, side by side, in `jobsResult`.
 */

const MAX_WAIT_S = 50;
/** Previews above this are sent as a link only; clients reject very large tool results. */
const MAX_PREVIEW_BYTES = 1_500_000;
/** The largest output handed over through MCP itself (see the `output` resource). */
const MAX_RESOURCE_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export interface ToolContext {
  app: FastifyInstance;
  /** `https://host` as the caller reached us, for absolute media links. */
  baseUrl: string;
}

type Content = CallToolResult['content'][number];

class ApiCallError extends Error {}

/** Call Pepper's own HTTP API in-process, with the configured token. */
async function call<T = unknown>(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const token = ctx.app.config.apiToken;
  const response = await ctx.app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = response.body;
  const parsed = text ? safeJson(text) : undefined;
  if (response.statusCode >= 400) {
    const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiCallError(
      error ? `${error.code}: ${error.message}` : `HTTP ${response.statusCode}: ${text.slice(0, 500)}`,
    );
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function json(value: unknown): Content {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}

function absolute(ctx: ToolContext, url: unknown): string | undefined {
  return typeof url === 'string' ? (url.startsWith('/') ? `${ctx.baseUrl}${url}` : url) : undefined;
}

/** Drop undefined keys, so a request body carries only what the caller set. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Resolve when the job settles or `seconds` pass, whichever is first. */
async function waitForJob(ctx: ToolContext, id: string, seconds: number): Promise<Job | null> {
  const jobs = ctx.app.jobs;
  const current = jobs.get(id);
  if (!current || TERMINAL.has(current.status) || seconds <= 0) return current;

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(jobs.get(id)), Math.min(seconds, MAX_WAIT_S) * 1000);
    const onUpdate = (job: Job) => {
      if (job.id === id && TERMINAL.has(job.status)) finish(job);
    };
    function finish(job: Job | null) {
      clearTimeout(timer);
      jobs.off('updated', onUpdate);
      resolve(job);
    }
    jobs.on('updated', onUpdate);
  });
}

/** The parts of a job a model needs to act on, with links made absolute. */
function summarizeJob(ctx: ToolContext, job: Job): Record<string, unknown> {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const metadata = (result.metadata ?? {}) as Record<string, unknown>;
  const output = (result.image_url ?? result.video_url ?? result.audio_url) as string | undefined;
  return defined({
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    step: job.step,
    total_steps: job.totalSteps,
    error: job.error,
    output_name: output ? decodeURIComponent(output.split('/').pop() ?? '') : undefined,
    url: absolute(ctx, output),
    text: result.text as string | undefined,
    seed: metadata.seed as number | undefined,
    duration_ms: metadata.duration_ms as number | undefined,
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    next:
      job.status === 'queued' || job.status === 'running'
        ? `Still ${job.status}. Call get_job with id "${job.id}" (wait_seconds up to ${MAX_WAIT_S}) to follow it.`
        : undefined,
  });
}

/**
 * An inline copy of an image output, so the chat can show it. Re-encoded to a
 * 1024px JPEG when ffmpeg is present, since a full-size PNG is often several
 * megabytes; without ffmpeg only files already small enough are sent.
 */
async function imagePreview(ctx: ToolContext, job: Job): Promise<Content | null> {
  const url = (job.result as Record<string, unknown> | undefined)?.image_url;
  if (typeof url !== 'string') return null;
  const name = decodeURIComponent(url.split('/').pop() ?? '');
  let path: string;
  try {
    path = safeResolve(ctx.app.paths.outputDir, name);
    await stat(path);
  } catch {
    return null;
  }

  if (await ffmpegAvailable()) {
    const out = join(tmpdir(), `pepper-mcp-${process.pid}-${Date.now()}.jpg`);
    try {
      await runFfmpeg(['-i', path, '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', out], 30_000);
      const data = await readFile(out);
      if (data.length <= MAX_PREVIEW_BYTES) {
        return { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' };
      }
    } catch {
      // Fall through to the raw file.
    } finally {
      await unlink(out).catch(() => {});
    }
  }

  const mime = IMAGE_MIME[extname(name).toLowerCase()];
  if (!mime) return null;
  const data = await readFile(path);
  if (data.length > MAX_PREVIEW_BYTES) return null;
  return { type: 'image', data: data.toString('base64'), mimeType: mime };
}

/**
 * A job as the media view draws it: the summary, plus what kind of media the
 * output is, a link the view's iframe can load without credentials, and where
 * in `content` the inline image preview sits.
 */
function viewJob(ctx: ToolContext, job: Job, previewIndex?: number): Record<string, unknown> {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const media = result.image_url ? 'image' : result.video_url ? 'video' : result.audio_url ? 'audio' : undefined;
  const summary = summarizeJob(ctx, job);
  const name = summary.output_name as string | undefined;
  return defined({
    ...summary,
    next: undefined,
    text: undefined,
    media,
    media_url: media && name ? absolute(ctx, signMediaUrl(ctx.app.config.apiToken, name)) : undefined,
    preview: previewIndex,
  });
}

/** Report jobs to the model (`content`) and to the media view (`structuredContent`). */
export async function jobsResult(ctx: ToolContext, jobs: Job[]): Promise<CallToolResult> {
  const content: Content[] = [];
  const view: Array<Record<string, unknown>> = [];
  for (const job of jobs) {
    content.push(json(summarizeJob(ctx, job)));
    const preview = job.status === 'completed' ? await imagePreview(ctx, job) : null;
    if (preview) content.push(preview);
    view.push(viewJob(ctx, job, preview ? content.length - 1 : undefined));
  }
  return { content, structuredContent: { jobs: view } };
}

async function jobResult(ctx: ToolContext, job: Job): Promise<CallToolResult> {
  return { ...(await jobsResult(ctx, [job])), isError: job.status === 'failed' };
}

/** Enqueue through the API, wait up to `wait` seconds, and report. */
async function submit(
  ctx: ToolContext,
  url: string,
  body: Record<string, unknown>,
  wait: number,
): Promise<CallToolResult> {
  const created = await call<Job | { jobs: Job[] }>(ctx, 'POST', url, defined(body));
  const jobs = 'jobs' in created ? created.jobs : [created];
  if (jobs.length === 1) {
    return jobResult(ctx, (await waitForJob(ctx, jobs[0].id, wait)) ?? jobs[0]);
  }
  // A batch: wait on each in turn within the one budget, then report all.
  const deadline = Date.now() + Math.min(wait, MAX_WAIT_S) * 1000;
  const settled: Job[] = [];
  for (const job of jobs) {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    settled.push((await waitForJob(ctx, job.id, left)) ?? job);
  }
  return jobsResult(ctx, settled);
}

const waitSeconds = (fallback: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_S)
    .default(fallback)
    .describe(`Seconds to wait for the result before returning a job id to poll (max ${MAX_WAIT_S}).`);

const MODEL_KINDS = ['image', 'video', 'audio', 'llm'] as const;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
/**
 * Marks a tool whose result the media view renders. Both spellings: the
 * nested key is the specification's, the flat one what earlier hosts read.
 */
const SHOWS_MEDIA = { ui: { resourceUri: MEDIA_VIEW_URI }, 'ui/resourceUri': MEDIA_VIEW_URI };
/** Said once per media tool, so the model does not repeat what the view already shows. */
const SHOWN =
  ' The result is displayed to the user in the chat (image, player or progress), so do not paste its link.';

export function registerPepperTools(server: McpServer, ctx: ToolContext): void {
  // Read per request, so the CSP names the origin this caller reached us on.
  server.registerResource(
    'media-view',
    MEDIA_VIEW_URI,
    {
      title: 'Pepper media',
      description: 'Shows generated images, video and audio, and the progress of running jobs.',
      mimeType: MEDIA_VIEW_MIME,
      _meta: mediaViewMeta(ctx.baseUrl),
    },
    async () => ({
      contents: [
        { uri: MEDIA_VIEW_URI, mimeType: MEDIA_VIEW_MIME, text: MEDIA_VIEW_HTML, _meta: mediaViewMeta(ctx.baseUrl) },
      ],
    }),
  );

  // The media view's second way to a file. Normally it loads a signed link
  // straight from Pepper; a host that does not apply the view's CSP, or
  // sandboxes it without an origin, blocks that, and the bytes can still
  // travel through the MCP connection the host already trusts. Capped,
  // because base64 in a JSON response is no way to move a long video.
  server.registerResource(
    'output',
    new ResourceTemplate('pepper://outputs/{name}', { list: undefined }),
    { title: 'A generated output', description: 'One generated image, video or audio file, by output_name.' },
    async (uri, variables) => {
      const name = decodeURIComponent(String(variables.name));
      let path: string;
      let size: number;
      try {
        path = safeResolve(ctx.app.paths.outputDir, name);
        size = (await stat(path)).size;
      } catch {
        throw new ApiCallError(`OUTPUT_NOT_FOUND: no output named ${name}`);
      }
      if (size > MAX_RESOURCE_BYTES) {
        throw new ApiCallError(`OUTPUT_TOO_LARGE: ${name} is ${size} bytes; open its link instead`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: contentType(name), blob: (await readFile(path)).toString('base64') }],
      };
    },
  );

  // --- Discovery ------------------------------------------------------------

  server.registerTool(
    'pepper_status',
    {
      title: 'Pepper status',
      description:
        'Check that Pepper is up and what it can do right now: backend states, GPU/RAM/volume use, ' +
        'the job queue, and installed models by kind (with whether each is ready). Call this ' +
        'first in a session, and to find a valid `model` id before generating.',
      annotations: READ_ONLY,
    },
    async () => {
      const [status, models] = await Promise.all([
        call<Record<string, unknown>>(ctx, 'GET', '/v1/system/status'),
        call<{ models: Array<Record<string, unknown>> }>(ctx, 'GET', '/v1/models'),
      ]);
      const byKind: Record<string, unknown[]> = {};
      for (const m of models.models) {
        (byKind[String(m.kind)] ??= []).push(
          defined({
            id: m.id,
            name: m.name,
            ready: m.ready,
            // Only image bundles distinguish image from video; for every
            // other kind `mode` is a meaningless default.
            mode: m.kind === 'image' || m.kind === 'video' ? m.mode : undefined,
            capabilities: (m.capabilities as unknown[] | undefined)?.length ? m.capabilities : undefined,
          }),
        );
      }

      // The status route serves the Preferences screen, so each backend
      // carries its whole CLI argument table. That is thousands of tokens a
      // model never needs on every status call; keep what says whether a
      // backend can run and why it cannot.
      const backends = (status.backends as Array<Record<string, unknown>>).map((b) =>
        defined({
          backend: b.backend,
          label: b.label,
          status: b.status,
          installed: b.installed,
          release: b.releaseTag,
          restarts: b.restarts || undefined,
          error: b.lastError,
          // Why an on-demand backend was skipped, e.g. no models installed.
          note: b.note,
          recent_output: (b.recentOutput as unknown[] | undefined)?.length
            ? (b.recentOutput as unknown[]).slice(-5)
            : undefined,
        }),
      );
      return {
        content: [
          json(
            defined({
              version: status.version,
              uptime_s: status.uptime,
              accel: status.accel,
              base_url: ctx.baseUrl,
              resources: status.resources,
              storage: status.storage ?? undefined,
              jobs: status.jobs,
              activity: status.activity,
              catalogue: status.catalogue,
              backends,
              models: byKind,
            }),
          ),
        ],
      };
    },
  );

  server.registerTool(
    'list_models',
    {
      title: 'List installed models',
      description:
        'Installed model bundles with full detail (components, defaults, LoRAs, capabilities). ' +
        'Use when choosing settings for a specific model; pepper_status is enough to find ids.',
      inputSchema: { kind: z.enum(MODEL_KINDS).optional() },
      annotations: READ_ONLY,
    },
    async ({ kind }) => ({ content: [json(await call(ctx, 'GET', `/v1/models${query({ kind })}`))] }),
  );

  // --- Generation -----------------------------------------------------------

  const loras = z
    .array(z.object({ name: z.string(), weight: z.number().min(-4).max(4).optional() }))
    .max(8)
    .optional()
    .describe("LoRAs from the model bundle's lora/ folder, by file name without extension.");

  const hires = z
    .object({
      enabled: z.boolean().optional(),
      scale: z.number().min(1).max(4).optional(),
      denoise: z.number().min(0).max(1).optional(),
      steps: z.number().int().min(1).max(200).optional(),
      upscaler: z.string().optional(),
    })
    .optional()
    .describe(
      'Hires "detail" pass: upscale the first result, then refine it. Models ship a recommended one; ' +
        'pass {enabled:false} to skip it, or scale/denoise (0.25-0.4 sharpens, higher reinvents detail) to tune it.',
    );
  const scheduler = z.string().optional().describe('sd-cli scheduler (simple, karras, beta, …); model default if omitted.');

  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image',
      description:
        'Text-to-image, image-to-image or image editing with an installed image model. ' +
        'Omitted settings use the model defaults, which are usually right. For img2img or ' +
        'edit models, first put the source image into uploads with add_input and pass its ' +
        'name as init_image or in ref_images. Returns the image inline plus a link.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        model: z.string().describe('Image model id from pepper_status.'),
        prompt: z.string().min(1),
        negative_prompt: z.string().optional(),
        width: z.number().int().min(64).optional(),
        height: z.number().int().min(64).optional(),
        steps: z.number().int().min(1).max(200).optional(),
        cfg_scale: z.number().min(0).max(30).optional(),
        seed: z.number().int().min(-1).optional(),
        sampler: z.string().optional(),
        init_image: z.string().optional().describe('Upload name (from add_input) for img2img.'),
        strength: z.number().min(0).max(1).optional(),
        ref_images: z.array(z.string()).max(16).optional().describe('Upload names for edit models.'),
        loras,
        hires,
        scheduler,
        batch: z.number().int().min(1).max(8).optional(),
        wait_seconds: waitSeconds(MAX_WAIT_S),
      },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/jobs', body, wait_seconds),
  );

  server.registerTool(
    'generate_video',
    {
      title: 'Generate a video',
      description:
        'Text-to-video, image-to-video (init_image) or speech-to-video (audio, for models whose ' +
        'capabilities include "s2v") with an installed video model. Videos take minutes: this ' +
        'returns a job id immediately by default; follow it with get_job.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        model: z.string().describe('Video model id from pepper_status.'),
        prompt: z.string().min(1),
        negative_prompt: z.string().optional(),
        init_image: z.string().optional().describe('Upload name (from add_input) for image-to-video.'),
        audio: z.string().optional().describe('Upload name of a speech clip, for speech-to-video.'),
        width: z.number().int().min(64).optional(),
        height: z.number().int().min(64).optional(),
        video_frames: z.number().int().min(1).max(257).optional(),
        fps: z.number().int().min(1).max(60).optional(),
        steps: z.number().int().min(1).max(200).optional(),
        cfg_scale: z.number().min(0).max(30).optional(),
        flow_shift: z.number().min(0).optional(),
        seed: z.number().int().min(-1).optional(),
        loras,
        hires: hires.describe('LTX-2: its latent upscaler renders e.g. 640x360 up to 1280x720; see the model default.'),
        wait_seconds: waitSeconds(0),
      },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/jobs', body, wait_seconds),
  );

  server.registerTool(
    'generate_speech',
    {
      title: 'Generate speech',
      description:
        'Text-to-speech with an installed audio model. `voice` picks a preset or built-in ' +
        'speaker; `voice_ref` clones the voice in an uploaded clip; voice-design models need ' +
        '`instructions` describing the voice. Returns a link to the audio file.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        model: z.string().describe('Audio model id from pepper_status.'),
        input: z.string().min(1).describe('The text to speak.'),
        voice: z.string().optional(),
        voice_ref: z.string().optional().describe('Upload name of a reference clip (from add_input).'),
        instructions: z.string().optional(),
        wait_seconds: waitSeconds(MAX_WAIT_S),
      },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/jobs/audio', body, wait_seconds),
  );

  server.registerTool(
    'generate_music',
    {
      title: 'Generate music',
      description:
        'A song or instrumental from an installed music model (audio models whose task is "gen": ' +
        'ACE-Step 1.5, HeartMuLa, Stable Audio 3). `prompt` is the style — genre, instruments, mood, ' +
        'vocal type, tempo; `lyrics` uses [Verse]/[Chorus]/[Bridge] markers, omit for instrumental. ' +
        'A few minutes of music takes about a minute; this returns a job id by default.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        model: z.string().describe('Music model id from pepper_status (kind audio).'),
        prompt: z.string().min(1),
        lyrics: z.string().optional(),
        duration_seconds: z.number().min(1).max(600).optional(),
        steps: z.number().int().min(1).max(200).optional(),
        seed: z.number().int().min(-1).optional(),
        wait_seconds: waitSeconds(0),
      },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/jobs/music', body, wait_seconds),
  );

  server.registerTool(
    'generate_text',
    {
      title: 'Generate text',
      description:
        "Run a prompt through one of Pepper's local LLMs (kind llm in pepper_status). Useful " +
        'for testing a model; for ordinary writing, answer directly instead.',
      inputSchema: {
        model: z.string(),
        prompt: z.string().min(1).optional(),
        messages: z
          .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
          .min(1)
          .optional()
          .describe('Chat messages; give either this or prompt.'),
        max_tokens: z.number().int().min(1).max(32768).optional(),
        temperature: z.number().min(0).max(2).optional(),
        wait_seconds: waitSeconds(MAX_WAIT_S),
      },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/jobs/text', body, wait_seconds),
  );

  server.registerTool(
    'upscale_image',
    {
      title: 'Upscale an image or video',
      description:
        'Images: ESRGAN 2x or 4x. Videos: SeedVR2 diffusion super-resolution to `resolution` ' +
        '(short side, default 1080), keeping the soundtrack — the standard finishing pass for ' +
        'generated video; minutes per clip, so poll with get_job. Takes an output_name or upload name.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        image: z.string().describe('output_name from a finished job, or an upload name (image or video).'),
        scale: z.union([z.literal(2), z.literal(4)]).optional().describe('Images only; default 4.'),
        resolution: z.number().int().min(360).max(2160).optional().describe('Videos only: target short side.'),
        quality: z.enum(['best', 'sharp', 'fast']).optional().describe('Videos only: SeedVR2 7B, 7B sharp, or 3B.'),
        source: z.enum(['output', 'upload']).default('output'),
        wait_seconds: waitSeconds(MAX_WAIT_S),
      },
    },
    async ({ wait_seconds, ...body }) =>
      submit(
        ctx,
        '/v1/jobs/upscale',
        /\.(webm|mp4|mov|mkv|avi)$/i.test(body.image) ? body : { ...body, scale: body.scale ?? 4 },
        wait_seconds,
      ),
  );

  // --- Jobs -----------------------------------------------------------------

  server.registerTool(
    'get_job',
    {
      title: 'Get a job',
      description:
        'Status and result of a generation job, optionally waiting for it to finish. Shows ' +
        'image results inline.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: { id: z.string(), wait_seconds: waitSeconds(30) },
      annotations: READ_ONLY,
    },
    async ({ id, wait_seconds }) => {
      const job = await waitForJob(ctx, id, wait_seconds);
      if (!job) throw new ApiCallError(`JOB_NOT_FOUND: Job not found: ${id}`);
      return jobResult(ctx, job);
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent jobs, newest first.',
      inputSchema: {
        kind: z.enum(['image', 'video', 'audio', 'text']).optional(),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const { jobs } = await call<{ jobs: Job[] }>(ctx, 'GET', `/v1/jobs${query(args)}`);
      return { content: [json(jobs.map((job) => summarizeJob(ctx, job)))] };
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a job',
      description: 'Abort a queued or running job.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({ content: [json(await call(ctx, 'POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`))] }),
  );

  // --- Inputs ---------------------------------------------------------------

  server.registerTool(
    'add_input',
    {
      title: 'Add an input file',
      description:
        'Put an image or audio clip into uploads so a generation can use it as init_image, ' +
        'ref_images, audio or voice_ref. Give exactly one of: `output` (a previous output_name), ' +
        '`url` (fetched by Pepper), or `data_base64` with `filename`. Returns the upload name.',
      inputSchema: {
        output: z.string().optional(),
        url: z.string().url().optional(),
        data_base64: z.string().optional(),
        filename: z.string().optional().describe('Needed with data_base64, for the file type.'),
      },
    },
    async ({ output, url, data_base64, filename }) => {
      if ([output, url, data_base64].filter(Boolean).length !== 1) {
        throw new ApiCallError('VALIDATION_ERROR: give exactly one of output, url or data_base64');
      }
      if (output) {
        return { content: [json(await call(ctx, 'POST', '/v1/inputs/from-output', { name: output }))] };
      }

      let data: Buffer;
      let ext: string;
      if (url) {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new ApiCallError(`DOWNLOAD_FAILED: ${response.status} fetching ${url}`);
        data = Buffer.from(await response.arrayBuffer());
        ext = extname(new URL(url).pathname) || extFromType(response.headers.get('content-type'));
      } else {
        data = Buffer.from(data_base64!, 'base64');
        ext = extname(filename ?? '');
      }
      if (!ext) throw new ApiCallError('VALIDATION_ERROR: cannot tell the file type; pass a filename');

      // Written directly rather than through POST /v1/inputs: that route is
      // multipart, which app.inject cannot build without a form library. The
      // naming mirrors it — never the caller's filename.
      const name = uniqueOutputName(ext.replace(/^\./, '').toLowerCase(), 'upload');
      await writeFile(safeResolve(ctx.app.paths.uploadsDir, name), data);
      return { content: [json({ name, size: data.length, url: `${ctx.baseUrl}/v1/inputs/${name}` })] };
    },
  );

  // --- Models and the catalogue --------------------------------------------

  server.registerTool(
    'catalogue_search',
    {
      title: 'Search the model catalogue',
      description:
        'Models available to install from the remote catalogue (pepper-catalogue.json). ' +
        'Compare ids with pepper_status to see which are already installed.',
      inputSchema: { kind: z.enum(MODEL_KINDS).optional(), search: z.string().optional() },
      annotations: READ_ONLY,
    },
    async (args) => ({ content: [json(await call(ctx, 'GET', `/v1/catalogue${query(args)}`))] }),
  );

  server.registerTool(
    'catalogue_files',
    {
      title: 'List installable files',
      description:
        "The live file list (quantizations and sizes) for each component of a catalogue model. " +
        'Use before catalogue_install to pick a quantization that fits the GPU.',
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ id }) => ({
      content: [json(await call(ctx, 'GET', `/v1/catalogue/${encodeURIComponent(id)}/files`))],
    }),
  );

  server.registerTool(
    'catalogue_install',
    {
      title: 'Install a catalogue model',
      description:
        'Download a catalogue model onto this Pepper instance. For each required component ' +
        '(and optional ones if include_optional) it picks the file whose name contains `quant` ' +
        '(e.g. "Q4_K_M", "Q8_0", "bf16"), else the catalogue\'s recommended file, else the smallest. ' +
        'Returns download ids; follow them ' +
        'with list_downloads. Large models take many minutes.',
      inputSchema: {
        id: z.string(),
        quant: z.string().optional(),
        include_optional: z.boolean().default(false),
        bundle: z.string().optional().describe('Bundle name; defaults to the catalogue id.'),
      },
    },
    async ({ id, quant, include_optional, bundle }) => {
      const { components } = await call<{ components: CatalogueComponent[] }>(
        ctx,
        'GET',
        `/v1/catalogue/${encodeURIComponent(id)}/files`,
      );
      const selections = selectFiles(components, { quant, includeOptional: include_optional });
      const result = await call(ctx, 'POST', `/v1/catalogue/${encodeURIComponent(id)}/install`, {
        bundle,
        selections,
      });
      return { content: [json({ selected: selections, ...(result as object) })] };
    },
  );

  server.registerTool(
    'catalogue_refresh',
    {
      title: 'Refresh the catalogue',
      description: 'Refetch the remote catalogue now instead of waiting for its cache to expire.',
    },
    async () => ({ content: [json(await call(ctx, 'POST', '/v1/catalogue/refresh'))] }),
  );

  server.registerTool(
    'list_downloads',
    {
      title: 'List downloads',
      description: 'Model downloads and their progress (bytes done / total, speed, errors).',
      inputSchema: {
        status: z.enum(['queued', 'downloading', 'completed', 'failed', 'cancelled']).optional(),
        bundle: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => ({ content: [json(await call(ctx, 'GET', `/v1/downloads${query(args)}`))] }),
  );

  server.registerTool(
    'delete_model',
    {
      title: 'Delete an installed model',
      description: 'Delete a model bundle and all of its files from this instance, freeing disk.',
      inputSchema: { kind: z.enum(MODEL_KINDS), bundle: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ kind, bundle }) => {
      await call(ctx, 'DELETE', `/v1/models/${kind}/${encodeURIComponent(bundle)}`);
      return { content: [json({ deleted: `${kind}/${bundle}` })] };
    },
  );

  // --- Operations -----------------------------------------------------------

  server.registerTool(
    'get_logs',
    {
      title: 'Read logs',
      description:
        'Recent server and backend log records (sd-cli, llama.cpp, audio.cpp, Python runners, ' +
        'downloads, jobs). The first place to look when a job fails.',
      inputSchema: {
        source: z
          .enum(['app', 'http', 'job', 'download', 'sdcpp', 'llamacpp', 'audiocpp', 'python'])
          .optional(),
        min_level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ_ONLY,
    },
    async ({ source, min_level, search, limit }) => {
      const { records } = await call<{ records: unknown[] }>(
        ctx,
        'GET',
        `/v1/logs${query({ source, minLevel: min_level, search, limit })}`,
      );
      return { content: [json(records)] };
    },
  );

  server.registerTool(
    'backend_control',
    {
      title: 'Start, stop or restart a backend',
      description:
        'Backends start on demand and stop when idle, so this is rarely needed: use it to ' +
        'recover a wedged backend or to free GPU memory.',
      inputSchema: {
        backend: z.enum(['sdcpp', 'llamacpp', 'audiocpp', 'python', 'vllm']),
        action: z.enum(['start', 'stop', 'restart']),
      },
    },
    async ({ backend, action }) => ({
      content: [json(await call(ctx, 'POST', `/v1/backends/${backend}/${action}`))],
    }),
  );
}

function extFromType(type: string | null): string {
  const mime = type?.split(';')[0].trim();
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/flac': '.flac',
  };
  return (mime && known[mime]) ?? '';
}

export interface CatalogueFile {
  filename: string;
  size: number;
  url: string;
  quant?: string | null;
  recommended?: boolean;
}

export interface CatalogueComponent {
  slot: string;
  label?: string;
  required?: boolean;
  source?: { allFiles?: boolean };
  files: CatalogueFile[];
  error?: string;
}

/**
 * The file choice the install dialog leaves to a person, made by rule: every
 * file of an `allFiles` set, otherwise the file matching `quant`, otherwise the
 * catalogue's recommended file, otherwise the smallest.
 */
export function selectFiles(
  components: CatalogueComponent[],
  options: { quant?: string; includeOptional?: boolean },
): Array<{ slot: string; url: string; name: string }> {
  const quant = options.quant?.toLowerCase();
  const selections: Array<{ slot: string; url: string; name: string }> = [];
  for (const component of components) {
    if (!component.required && !options.includeOptional) continue;
    if (component.error || component.files.length === 0) {
      throw new ApiCallError(
        `INSTALL_FAILED: component "${component.label ?? component.slot}" has no installable files` +
          (component.error ? `: ${component.error}` : ''),
      );
    }
    const pick = component.source?.allFiles
      ? component.files
      : [
          (quant && component.files.find((f) => f.filename.toLowerCase().includes(quant))) ||
            component.files.find((f) => f.recommended) ||
            [...component.files].sort((a, b) => (a.size || Infinity) - (b.size || Infinity))[0],
        ];
    for (const file of pick) selections.push({ slot: component.slot, url: file.url, name: file.filename });
  }
  if (selections.length === 0) throw new ApiCallError('INSTALL_FAILED: nothing to install');
  return selections;
}
