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
import { analyzeSchema } from '../routes/analyze.js';
import { planSchema, renderSchema } from '../routes/projects.js';

/**
 * Pepper Pro over MCP. Claude is the director: it writes the plan (script →
 * assets → scenes → shots), renders draft takes, reviews them in the media
 * view, and finishes the ones worth keeping. Tools are few and coarse, like
 * Pepper's (see @pepper/core/mcp/kit.ts), and none waits past 50 s.
 */

const PROMPTING =
  'Prompts: describe the shot, its motion and its sound in one block. For recipes with the ' +
  '`subject-tags` capability (MiniMax H3), assets are introduced as <Subject n> and dialogue is ' +
  'written as `<Subject 1> says exactly this: "…".` — plan_project does this from `dialogue`.';

export function registerProTools(server: McpServer, ctx: ToolContext): void {
  registerMediaResources(server, ctx);

  server.registerTool(
    'pro_status',
    {
      title: 'Pepper Pro status',
      description:
        'Is Pepper Pro up, on what hardware tier and licence mode, what the GPU and queue are doing, ' +
        'and which recipes are installed. Call first in a session.',
      annotations: READ_ONLY,
    },
    async () => {
      const status = await call<Record<string, unknown>>(ctx, 'GET', '/v1/system/status');
      const recipes = await call<{ recipes: { id: string; kind: string; state: string; name: string }[] }>(ctx, 'GET', '/v1/recipes');
      return {
        content: [
          json({
            tier: status.tier,
            licence_mode: status.licence_mode,
            resources: status.resources,
            jobs: status.jobs,
            backends: (status.backends as { backend: string; status: string }[]).map((b) => ({ backend: b.backend, status: b.status })),
            recipes: recipes.recipes.map((r) => ({ id: r.id, kind: r.kind, name: r.name, state: r.state })),
          }),
        ],
      };
    },
  );

  server.registerTool(
    'list_recipes',
    {
      title: 'List recipes',
      description:
        'Recipes (pinned ComfyUI pipelines) with their capabilities, modes, parameters, licence and ' +
        'install state. Use a recipe id with `generate`, or on a shot in `plan_project`.',
      inputSchema: { kind: z.enum(['image', 'video', 'audio']).optional() },
      annotations: READ_ONLY,
    },
    async (args) => {
      const { recipes } = await call<{ recipes: Record<string, unknown>[] }>(ctx, 'GET', `/v1/recipes${query(args)}`);
      return {
        content: [
          json(
            recipes.map((r) =>
              defined({
                id: r.id as string,
                name: r.name as string,
                kind: r.kind as string,
                state: r.state as string,
                capabilities: r.capabilities as string[],
                modes: r.modes as unknown[],
                params: (r.params as { name: string; type: string; required?: boolean; description?: string }[]).map((p) =>
                  defined({ name: p.name, type: p.type, required: p.required || undefined, description: p.description }),
                ),
                licence: (r.licence as { name: string; commercial: string; excluded_territories: string[] }),
                licence_block: r.licence_block as string | undefined,
              }),
            ),
          ),
        ],
      };
    },
  );

  server.registerTool(
    'install_recipe',
    {
      title: 'Install a recipe',
      description: "Download a recipe's model files for this tier (queued; follow with get_logs or pro_status).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => ({ content: [json(await call(ctx, 'POST', `/v1/recipes/${encodeURIComponent(id)}/install`, {}))] }),
  );

  server.registerTool(
    'generate',
    {
      title: 'Run a recipe',
      description:
        'Generate an image, video or audio clip with one recipe outside a project (look ideas, a ' +
        'character sheet, a keyframe). Inputs such as `image` take upload names from add_input. ' +
        PROMPTING +
        SHOWN,
      _meta: SHOWS_MEDIA,
      inputSchema: {
        recipe: z.string(),
        mode: z.string().optional().describe('e.g. "draft" or "final"; the recipe default when omitted.'),
        params: z.record(z.unknown()).default({}),
        batch: z.number().int().min(1).max(8).optional(),
        wait_seconds: waitSeconds(20),
      },
    },
    async ({ recipe, mode, params, batch, wait_seconds }) =>
      submit(ctx, '/v1/jobs', { recipe, mode, params, batch }, wait_seconds),
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
        'Short-drama shots are 3–8 s; a line or two of dialogue per 5 s. ' +
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
      await call(ctx, 'POST', `/v1/projects/${encodeURIComponent(id)}/plan`, plan);
      return { content: [json(summarizeProject(await call(ctx, 'GET', `/v1/projects/${encodeURIComponent(id)}`)))] };
    },
  );

  server.registerTool(
    'render_shots',
    {
      title: 'Render shots',
      description:
        'Queue takes of shots: drafts first (several per shot, cheap), then finish the chosen draft ' +
        'with `from_take` and `mode: "final"`, which reuses its seed. Returns the takes; follow them ' +
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
      const { takes } = await call<{ takes: { jobId: string }[] }>(ctx, 'POST', '/v1/shots/render', render);
      const jobs: Job[] = [];
      const deadline = Date.now() + Math.min(wait_seconds, MAX_WAIT_S) * 1000;
      for (const take of takes) {
        const job = ctx.jobs.get(take.jobId);
        if (!job) continue;
        const left = Math.max(0, deadline - Date.now());
        jobs.push(left > 0 ? ((await waitSettled(ctx, job.id, left)) ?? job) : job);
      }
      const result = await jobsResult(ctx, jobs);
      result.content.unshift(json({ takes: takes.map((t) => t) }));
      return result;
    },
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get a project',
      description:
        'A project: its assets, scenes, shots (with their takes, statuses and chosen take) and cuts. ' +
        'Without project_id, lists projects. To choose a take, pass choose; to export a cut of the ' +
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
      if (!project_id) return { content: [json(await call(ctx, 'GET', '/v1/projects'))] };
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
        'stores the verdict on it (shown by get_project).',
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

/** What Claude needs from a project, without every column of every row. */
function summarizeProject(project: unknown): unknown {
  const p = project as {
    id: string;
    name: string;
    aspect: string;
    style: string;
    assets: { id: string; kind: string; name: string; images: string[] }[];
    scenes: {
      id: string;
      title: string;
      shots: {
        id: string;
        kind: string;
        durationS: number;
        prompt: string;
        recipeId: string | null;
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
    assets: p.assets.map((a) => ({ id: a.id, kind: a.kind, name: a.name, images: a.images.length })),
    scenes: p.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        kind: shot.kind,
        duration_s: shot.durationS,
        prompt: shot.prompt.slice(0, 160),
        recipe: shot.recipeId ?? undefined,
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
