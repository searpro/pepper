import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Job } from '@pepper/core/jobs/manager.js';
import {
  call,
  defined,
  json,
  jobsResult,
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
} from '@pepper/core/mcp/kit.js';
import { ASPECT_RATIOS } from '../generate.js';
import { analyzeSchema } from '../routes/analyze.js';
import { planSchema, renderSchema } from '../routes/projects.js';

/**
 * Pepper Pro over MCP. Claude is the director: it writes the plan (script →
 * assets → scenes → shots), renders draft takes, reviews them in the media
 * view, and finishes the ones worth keeping. Tools are few and coarse, like
 * Pepper's (see @pepper/core/mcp/kit.ts), and none waits past 50 s.
 */

const PROMPTING =
  'Prompts: write each shot as the director would — framing, camera (type + amplitude + speed + where it ' +
  'ends, e.g. "The camera pushes in with small amplitude at slow speed toward her hands"), the action as it ' +
  'unfolds, `dialogue` lines, and `sound` (ambience and effects, then "Music: …" for the score). For MiniMax ' +
  'H3 the shot is composed into its own structured format (speaker IDs, <d> dialogue, <Subject n> bindings, ' +
  'frame alignment); a later beat inside one shot is written as "[Shot 2] At 00:04.000, the camera cuts to …". ' +
  'A prompt already in that format is used as written.';

export function registerProTools(server: McpServer, ctx: ToolContext): void {
  registerMediaResources(server, ctx);

  server.registerTool(
    'pro_status',
    {
      title: 'Pepper Pro status',
      description:
        'Is Pepper Pro up, on what hardware tier and licence mode, what the GPU and queue are doing, ' +
        'which recipes are installed, and the LoRA library (each LoRA\'s base and download state). Call first in a session.',
      annotations: READ_ONLY,
    },
    async () => {
      const status = await call<Record<string, unknown>>(ctx, 'GET', '/v1/system/status');
      const recipes = await call<{ recipes: { id: string; kind: string; state: string; name: string }[] }>(ctx, 'GET', '/v1/recipes');
      const library = await call<{
        loras: { id: string; name: string; base: string; state: string; trigger_words: string[]; download?: { received: number; total: number | null; error?: string } }[];
      }>(ctx, 'GET', '/v1/loras');
      return {
        content: [
          json({
            tier: status.tier,
            licence_mode: status.licence_mode,
            resources: status.resources,
            jobs: status.jobs,
            backends: (status.backends as { backend: string; status: string }[]).map((b) => ({ backend: b.backend, status: b.status })),
            recipes: recipes.recipes.map((r) => ({ id: r.id, kind: r.kind, name: r.name, state: r.state })),
            // The LoRA library, so an install_model lora_url can be followed to `installed`.
            loras: library.loras.map((l) =>
              defined({
                id: l.id,
                name: l.name,
                base: l.base,
                state: l.state,
                trigger_words: l.trigger_words.length ? l.trigger_words : undefined,
                progress: l.download?.total ? Math.round((l.download.received / l.download.total) * 100) / 100 : undefined,
                error: l.download?.error,
              }),
            ),
          }),
        ],
      };
    },
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'The models generate_image, generate_video and generate_audio can run: what each takes (prompt, image, ' +
        'end_image, reference_images, audio, …, required or optional), durations, aspect ratios, qualities ' +
        '(draft/final), licence, whether it is installed, measured seconds per output where verified, and the ' +
        'downloaded LoRAs that fit it (`loras`, with their trigger words).',
      inputSchema: { kind: z.enum(['image', 'video', 'audio']).optional() },
      annotations: READ_ONLY,
    },
    async (args) => {
      const { models } = await call<{ models: Record<string, unknown>[] }>(ctx, 'GET', `/v1/models${query(args)}`);
      return { content: [json(models.map((m) => defined({ ...m, description: undefined, install_bytes: m.installed ? undefined : m.install_bytes })))] };
    },
  );

  server.registerTool(
    'install_model',
    {
      title: 'Install a model or LoRA',
      description:
        "Download a model's files by `id` (queued; minutes for tens of GB), or add a LoRA to the library from " +
        '`lora_url` (a Civitai page, a HuggingFace repo or file, or a .safetensors link), with `base` when the ' +
        'source does not say which model it is for (pro_status shows when it is downloaded). Refused when ' +
        'the volume has no room.',
      inputSchema: {
        id: z.string().optional(),
        lora_url: z.string().url().optional(),
        base: z.string().optional().describe('A LoRA\'s base model: a lora_base from list_models.'),
        file: z.string().optional().describe('Which file, for a LoRA repository with several.'),
      },
    },
    async ({ id, lora_url, base, file }) => {
      if (lora_url) return { content: [json(await call(ctx, 'POST', '/v1/loras', defined({ url: lora_url, base, file })))] };
      if (!id) throw new Error('Give id (a model) or lora_url (a LoRA)');
      return { content: [json(await call(ctx, 'POST', `/v1/recipes/${encodeURIComponent(id)}/install`, {}))] };
    },
  );

  const generic = {
    model: z.string().optional().describe('A model id from list_models; the best installed fit when omitted.'),
    prompt: z.string().optional(),
    reference_images: z.array(z.string()).max(8).optional().describe('Pictures of people, products or places to keep consistent.'),
    quality: z.string().optional().describe('"draft" (faster, to try ideas) or "final"; the model default when omitted.'),
    seed: z.number().int().min(0).optional().describe('Reuse a seed to reproduce or finish a draft.'),
    count: z.number().int().min(1).max(8).optional().describe('Variations, each with its own seed.'),
    params: z.record(z.unknown()).optional().describe("The model's own parameters, for anything else."),
  };
  const loras = z
    .array(z.union([z.string(), z.object({ id: z.string(), strength: z.number().optional() })]))
    .max(8)
    .optional()
    .describe('LoRAs from list_models `loras` (ids, or { id, strength }); put their trigger words in the prompt.');
  const MEDIA_IN = 'Media inputs take a URL, a data URI, an upload name (add_input) or a previous output_name. ';
  const generateTool = (kind: 'image' | 'video' | 'audio', fallbackWait: number) =>
    async (args: Record<string, unknown>) => {
      const { wait_seconds, ...body } = args as { wait_seconds: number } & Record<string, unknown>;
      const created = await call<{ model: string; quality: string; jobs: Job[] }>(ctx, 'POST', '/v1/generate', defined({ ...body, kind }));
      const deadline = Date.now() + Math.min(wait_seconds ?? fallbackWait, MAX_WAIT_S) * 1000;
      const settled: Job[] = [];
      for (const job of created.jobs) {
        settled.push((await waitSettled(ctx, job.id, Math.max(0, deadline - Date.now()))) ?? job);
      }
      const result = await jobsResult(ctx, settled);
      result.content.unshift(json({ model: created.model, quality: created.quality }));
      return result;
    };

  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image',
      description:
        'Text to image, or an edit when `image` is given (restyle, recolour, try-on with reference_images). ' +
        MEDIA_IN +
        'Returns the job; images usually finish within the wait.' +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        ...generic,
        image: z.string().optional().describe('An image to edit or upscale.'),
        aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
        loras,
        wait_seconds: waitSeconds(40),
      },
    },
    generateTool('image', 40),
  );

  server.registerTool(
    'generate_video',
    {
      title: 'Generate a video',
      description:
        'Text or image to video, with sound on models that make it. `image` is the start frame, `end_image` ' +
        'the last; `reference_images` keep a cast consistent; `audio` drives lip-sync or a performance; ' +
        '`video` is motion to transfer. ' +
        MEDIA_IN +
        'Videos take minutes: this returns job ids at once (wait_seconds 0); follow them with get_job ' +
        '(`ids`, up to 50 s a call). Each finished job has a download_url. ' +
        PROMPTING +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        ...generic,
        image: z.string().optional().describe('Start frame, or the subject for talking and dancing models.'),
        end_image: z.string().optional(),
        audio: z.string().optional().describe('A voice or song to lip-sync or perform to.'),
        audio_2: z.string().optional().describe('The second speaker, for two-person models.'),
        video: z.string().optional().describe('Driving video, for motion transfer and character replacement.'),
        duration: z.number().positive().optional().describe('Seconds; list_models gives each model its range.'),
        aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
        loras,
        wait_seconds: waitSeconds(0),
      },
    },
    generateTool('video', 0),
  );

  server.registerTool(
    'generate_audio',
    {
      title: 'Generate speech or music',
      description:
        'Speech (`audio_type: "speech"`): `prompt` is the line; give `voice_reference` (a few seconds of a ' +
        'voice to clone) or `voice` (a preset name or a description of a voice). Music (`audio_type: ' +
        '"music"`): `prompt` is the style, `lyrics` the words, `duration` the length. ' +
        MEDIA_IN +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        ...generic,
        audio_type: z.enum(['speech', 'music']).optional(),
        voice_reference: z.string().optional(),
        voice: z.string().optional(),
        lyrics: z.string().optional(),
        duration: z.number().positive().optional(),
        wait_seconds: waitSeconds(40),
      },
    },
    generateTool('audio', 40),
  );

  // --- Projects ----------------------------------------------------------------

  server.registerTool(
    'plan_project',
    {
      title: 'Plan a project',
      description:
        'Create a project (give `name`) or update one (give `project_id`) from a plan: assets ' +
        '(characters, locations, props, products, voices, audio — each with a `ref` the plan uses), ' +
        'then scenes of shots (prompt, framing, camera, duration_s, dialogue as {speaker: ref, line}, ' +
        'sound, assets as refs, optional recipe). Returns the project with shot ids to render. ' +
        'Short-drama shots are 3–8 s; a line or two of dialogue per 5 s; faces hold best in close and ' +
        'medium shots. Give recurring characters a fixed visual description (and a voice description) ' +
        'and reference images, so every shot binds the same person. Library characters (get_project ' +
        'lists them) are used by naming them in shots and dialogue; `library: true` on an asset saves it ' +
        'there for every project. `loras` on an asset or shot (LoRA ids, list_models shows them) apply to ' +
        'every take on a model of their base, with their trigger words added to the prompt; a shot with no ' +
        'recipe gets one that runs them where its kind allows, and `skipped_loras` names any that cannot run. ' +
        PROMPTING,
      inputSchema: {
        project_id: z.string().optional(),
        name: z.string().optional(),
        aspect: z.enum(['9:16', '16:9', '1:1', '4:5', '4:3', '3:4', '21:9']).optional(),
        plan: planSchema,
      },
    },
    async ({ project_id, name, aspect, plan }) => {
      let id = project_id;
      if (!id) {
        if (!name) throw new Error('VALIDATION_ERROR: give project_id, or a name for a new project');
        id = (await call<{ id: string }>(ctx, 'POST', '/v1/projects', defined({ name, aspect }))).id;
      } else if (aspect) {
        await call(ctx, 'PATCH', `/v1/projects/${encodeURIComponent(id)}`, { aspect });
      }
      const planned = await call<{ skipped_loras?: unknown[] }>(ctx, 'POST', `/v1/projects/${encodeURIComponent(id)}/plan`, plan);
      const project = summarizeProject(await call(ctx, 'GET', `/v1/projects/${encodeURIComponent(id)}`)) as Record<string, unknown>;
      return { content: [json(planned.skipped_loras ? { ...project, skipped_loras: planned.skipped_loras } : project)] };
    },
  );

  server.registerTool(
    'render_shots',
    {
      title: 'Render shots',
      description:
        'Queue takes of shots: drafts first (several per shot, cheap), then finish the chosen draft ' +
        'with `from_take` and `mode: "final"`, which reuses its seed. `from_take` plus `retake_from` ' +
        '(seconds) keeps that take up to there and re-renders the rest. Shots longer than a recipe ' +
        'renders at once are chained automatically; `skipped_loras` names LoRAs a shot\'s recipe could not run. ' +
        '`master: true` upscales each shot\'s chosen take for ' +
        'delivery (LTX refine, then RTX Video upscale; soundtrack kept); cuts then use the masters. Returns the takes; follow them ' +
        `with get_project or get_job (up to ${MAX_WAIT_S} s).` +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        ...renderSchema.shape,
        choose: z.string().optional().describe('A take id to make its shot’s chosen take, before rendering.'),
        wait_seconds: waitSeconds(0),
      },
    },
    async ({ choose, wait_seconds, ...render }) => {
      if (choose) await call(ctx, 'POST', `/v1/takes/${encodeURIComponent(choose)}/choose`, {});
      const { takes, skipped_loras } = await call<{ takes: { jobId: string }[]; skipped_loras?: unknown[] }>(ctx, 'POST', '/v1/shots/render', render);
      const jobs: Job[] = [];
      const deadline = Date.now() + Math.min(wait_seconds, MAX_WAIT_S) * 1000;
      for (const take of takes) {
        const job = ctx.jobs.get(take.jobId);
        if (!job) continue;
        const left = Math.max(0, deadline - Date.now());
        jobs.push(left > 0 ? ((await waitSettled(ctx, job.id, left)) ?? job) : job);
      }
      const result = await jobsResult(ctx, jobs);
      result.content.unshift(json(skipped_loras?.length ? { takes, skipped_loras } : { takes }));
      return result;
    },
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description:
        'A project: its assets, scenes, shots (with their takes, statuses and chosen take) and cuts. ' +
        'Without project_id, lists projects and the shared library of characters, voices and other ' +
        'assets every project can use. To choose a take, pass choose; to export a cut of the ' +
        'chosen takes, pass export (creates the cut if none exists).',
      inputSchema: {
        project_id: z.string().optional(),
        choose: z.string().optional().describe('Take id to make its shot’s chosen take.'),
        export: z.boolean().optional(),
        subtitles: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ project_id, choose, export: doExport, subtitles }) => {
      if (!project_id) {
        const { projects } = await call<{ projects: unknown[] }>(ctx, 'GET', '/v1/projects');
        const { assets } = await call<{ assets: LibraryAsset[] }>(ctx, 'GET', '/v1/assets');
        return { content: [json({ projects, library: assets.map(summarizeAsset) })] };
      }
      const base = `/v1/projects/${encodeURIComponent(project_id)}`;
      if (choose) await call(ctx, 'POST', `/v1/takes/${encodeURIComponent(choose)}/choose`, {});
      if (doExport) {
        const project = await call<{ cuts: { id: string }[] }>(ctx, 'GET', base);
        const cut = project.cuts[0] ?? (await call<{ id: string }>(ctx, 'POST', `${base}/cuts`, defined({ subtitles })));
        if (subtitles !== undefined && project.cuts[0]) await call(ctx, 'PATCH', `/v1/cuts/${cut.id}`, { subtitles });
        await call(ctx, 'POST', `/v1/cuts/${encodeURIComponent(cut.id)}/export`, {});
      }
      return { content: [json(summarizeProject(await call(ctx, 'GET', base)))] };
    },
  );

  server.registerTool(
    'analyze',
    {
      title: 'Analyze media',
      description:
        '`beats`: tempo and beats of a track (give asset_id of a music asset, then set beatSync on the cut ' +
        'to cut on the beat). `stems`: split a song into vocals and accompaniment assets (lip-sync a ' +
        'performance to the vocals). `check`: a vision model reviews a finished take against its shot and ' +
        'stores the verdict on it (shown by get_project). `transcribe`: Whisper reads speech (an upload, or a ' +
        'take, judged against the text it was asked to say); use it on TTS lines before building on them.',
      inputSchema: { ...analyzeSchema.shape, wait_seconds: waitSeconds(30) },
    },
    async ({ wait_seconds, ...body }) => submit(ctx, '/v1/analyze', body, wait_seconds),
  );

  registerJobTools(server, ctx);
  registerInputTool(server, ctx);
  registerLogTool(server, ctx, {
    sources: ['app', 'http', 'job', 'download', 'comfy', 'llamacpp'],
    description: 'Recent server, ComfyUI and llama.cpp log records. The first place to look when a take fails.',
  });
}

async function waitSettled(ctx: ToolContext, id: string, ms: number): Promise<Job | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const job = ctx.jobs.get(id);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 500));
  }
  return ctx.jobs.get(id);
}

interface LibraryAsset {
  id: string;
  kind: string;
  name: string;
  description: string;
  images: string[];
  voice: { upload?: string; description?: string } | null;
  loras?: { id: string; strength?: number }[];
}

/** LoRAs as Claude needs them: ids (with a strength when one is set), or nothing. */
const loraRefs = (list: { id: string; strength?: number }[] | undefined) =>
  list?.length ? list.map((l) => (l.strength === undefined ? l.id : `${l.id} ×${l.strength}`)) : undefined;

/** A library asset as Claude needs it: enough to name it in a plan and know what it brings. */
function summarizeAsset(a: LibraryAsset): unknown {
  return defined({
    id: a.id,
    kind: a.kind,
    name: a.name,
    description: a.description || undefined,
    images: a.images,
    voice: a.voice?.upload || a.voice?.description ? a.voice : undefined,
    loras: loraRefs(a.loras),
  });
}

/** What Claude needs from a project, without every column of every row. */
function summarizeProject(project: unknown): unknown {
  const p = project as {
    id: string;
    name: string;
    aspect: string;
    style: string;
    assets: { id: string; kind: string; name: string; images: string[]; loras?: { id: string; strength?: number }[] }[];
    scenes: {
      id: string;
      title: string;
      shots: {
        id: string;
        kind: string;
        durationS: number;
        prompt: string;
        recipeId: string | null;
        loras?: { id: string; strength?: number }[];
        chosenTakeId: string | null;
        takes: {
          id: string;
          mode: string;
          status: string;
          progress: number;
          seed: number | null;
          url?: string;
          error?: unknown;
          score: number | null;
          review: { ok: boolean; score: number; issues: string[] } | null;
        }[];
      }[];
    }[];
    cuts: { id: string; name: string; items: unknown[]; export: unknown }[];
  };
  return {
    id: p.id,
    name: p.name,
    aspect: p.aspect,
    style: p.style || undefined,
    assets: p.assets.map((a) => defined({ id: a.id, kind: a.kind, name: a.name, images: a.images.length, loras: loraRefs(a.loras) })),
    scenes: p.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        kind: shot.kind,
        duration_s: shot.durationS,
        prompt: shot.prompt.slice(0, 160),
        recipe: shot.recipeId ?? undefined,
        loras: loraRefs(shot.loras),
        chosen: shot.chosenTakeId ?? undefined,
        takes: shot.takes.map((t) =>
          defined({
            id: t.id,
            mode: t.mode,
            status: t.status,
            progress: t.progress,
            seed: t.seed ?? undefined,
            score: t.score ?? undefined,
            review: t.review ? { ok: t.review.ok, score: t.review.score, issues: t.review.issues } : undefined,
            error: t.error,
          }),
        ),
      })),
    })),
    cuts: p.cuts.map((c) => ({ id: c.id, name: c.name, items: c.items.length, export: c.export })),
  };
}
