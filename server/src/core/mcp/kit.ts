import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { signMediaUrl } from '../auth.js';
import { safeResolve } from '../paths.js';
import { contentType } from '../routes/media.js';
import { uniqueOutputName } from '../util/files.js';
import { ffmpegAvailable, runFfmpeg } from '../util/ffmpeg.js';
import { JOB_KINDS, type Job, type JobManager } from '../jobs/manager.js';
import { MEDIA_VIEW_HTML, MEDIA_VIEW_MIME, MEDIA_VIEW_URI, mediaViewMeta } from './media-view.js';

/**
 * The MCP toolkit every product builds its tools from (see routes/mcp.ts for
 * the transport): calling the product's own API in-process, waiting on jobs,
 * reporting them to the model and to the media view, and the tools every
 * product shares (jobs, inputs, logs, the media resources).
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

export const MAX_WAIT_S = 50;
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
  /** The API token tools present to the product's own routes. */
  apiToken?: string;
  jobs: JobManager;
  outputDir: string;
  uploadsDir: string;
}

export type Content = CallToolResult['content'][number];

export class ApiCallError extends Error {}

/** Call Pepper's own HTTP API in-process, with the configured token. */
export async function call<T = unknown>(
  ctx: ToolContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const token = ctx.apiToken;
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

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.append(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function json(value: unknown): Content {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}

export function absolute(ctx: ToolContext, url: unknown): string | undefined {
  return typeof url === 'string' ? (url.startsWith('/') ? `${ctx.baseUrl}${url}` : url) : undefined;
}

/** Drop undefined keys, so a request body carries only what the caller set. */
export function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Resolve when the job settles or `seconds` pass, whichever is first. */
export async function waitForJob(ctx: ToolContext, id: string, seconds: number): Promise<Job | null> {
  const jobs = ctx.jobs;
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
export function summarizeJob(ctx: ToolContext, job: Job): Record<string, unknown> {
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
export async function imagePreview(ctx: ToolContext, job: Job): Promise<Content | null> {
  const url = (job.result as Record<string, unknown> | undefined)?.image_url;
  if (typeof url !== 'string') return null;
  const name = decodeURIComponent(url.split('/').pop() ?? '');
  let path: string;
  try {
    path = safeResolve(ctx.outputDir, name);
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
export function viewJob(ctx: ToolContext, job: Job, previewIndex?: number): Record<string, unknown> {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const media = result.image_url ? 'image' : result.video_url ? 'video' : result.audio_url ? 'audio' : undefined;
  const summary = summarizeJob(ctx, job);
  const name = summary.output_name as string | undefined;
  return defined({
    ...summary,
    next: undefined,
    text: undefined,
    media,
    media_url: media && name ? absolute(ctx, signMediaUrl(ctx.apiToken, name)) : undefined,
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

export async function jobResult(ctx: ToolContext, job: Job): Promise<CallToolResult> {
  return { ...(await jobsResult(ctx, [job])), isError: job.status === 'failed' };
}

/** Enqueue through the API, wait up to `wait` seconds, and report. */
export async function submit(
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

export const waitSeconds = (fallback: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_S)
    .default(fallback)
    .describe(`Seconds to wait for the result before returning a job id to poll (max ${MAX_WAIT_S}).`);

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
/**
 * Marks a tool whose result the media view renders. Both spellings: the
 * nested key is the specification's, the flat one what earlier hosts read.
 */
export const SHOWS_MEDIA = { ui: { resourceUri: MEDIA_VIEW_URI }, 'ui/resourceUri': MEDIA_VIEW_URI };
/** Said once per media tool, so the model does not repeat what the view already shows. */
export const SHOWN =
  ' The result is displayed to the user in the chat (image, player or progress), so do not paste its link.';

/** The media view and the `pepper://outputs/{name}` fallback it reads through. */
export function registerMediaResources(server: McpServer, ctx: ToolContext): void {
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
        path = safeResolve(ctx.outputDir, name);
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
}

/** get_job, list_jobs and cancel_job. */
export function registerJobTools(server: McpServer, ctx: ToolContext): void {
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
        kind: z.enum(JOB_KINDS).optional(),
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
}

/** add_input: an image or audio clip into uploads, from an output, a URL or bytes. */
export function registerInputTool(server: McpServer, ctx: ToolContext): void {
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
      await writeFile(safeResolve(ctx.uploadsDir, name), data);
      return { content: [json({ name, size: data.length, url: `${ctx.baseUrl}/v1/inputs/${name}` })] };
    },
  );
}

/** get_logs, filtered to the product's log sources. */
export function registerLogTool(
  server: McpServer,
  ctx: ToolContext,
  options: { sources: [string, ...string[]]; description: string },
): void {
  server.registerTool(
    'get_logs',
    {
      title: 'Read logs',
      description: options.description,
      inputSchema: {
        source: z.enum(options.sources).optional(),
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
