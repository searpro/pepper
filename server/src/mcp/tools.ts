import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ApiCallError,
  call,
  defined,
  json,
  MAX_WAIT_S,
  query,
  READ_ONLY,
  registerInputTool,
  registerJobTools,
  registerLogTool,
  registerMediaResources,
  SHOWN,
  SHOWS_MEDIA,
  submit,
  waitSeconds,
  type ToolContext,
} from '../core/mcp/kit.js';

export { jobsResult, type ToolContext } from '../core/mcp/kit.js';

/**
 * The tools Pepper exposes over MCP (see core/routes/mcp.ts for the
 * transport, and core/mcp/kit.ts for how every tool is built: a thin wrapper
 * over the HTTP API, called in-process, with long work returned as a job id).
 */

const MODEL_KINDS = ['image', 'video', 'audio', 'llm'] as const;

export function registerPepperTools(server: McpServer, ctx: ToolContext): void {
  registerMediaResources(server, ctx);

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

  registerJobTools(server, ctx);

  registerInputTool(server, ctx);

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

  registerLogTool(server, ctx, {
    sources: ['app', 'http', 'job', 'download', 'sdcpp', 'llamacpp', 'audiocpp', 'python'],
    description:
      'Recent server and backend log records (sd-cli, llama.cpp, audio.cpp, Python runners, ' +
      'downloads, jobs). The first place to look when a job fails.',
  });

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
