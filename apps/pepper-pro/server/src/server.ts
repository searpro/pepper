import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createCoreApp, serveSpa } from '@pepper/core/app.js';
import { authRoutes } from '@pepper/core/auth.js';
import { DownloadManager } from '@pepper/core/downloads/manager.js';
import { EngineRegistry, processEngine } from '@pepper/core/engines/engine.js';
import { JobManager } from '@pepper/core/jobs/manager.js';
import { downloadRoutes } from '@pepper/core/routes/downloads.js';
import { coreJobRoutes } from '@pepper/core/routes/jobs.js';
import { logRoutes } from '@pepper/core/routes/logs.js';
import { mcpRoutes } from '@pepper/core/routes/mcp.js';
import { mediaRoutes } from '@pepper/core/routes/media.js';
import { systemRoutes } from '@pepper/core/routes/system.js';
import { ResourceMonitor } from '@pepper/core/services/resources.js';
import { StorageMonitor } from '@pepper/core/services/storage.js';
import { TextService } from '@pepper/core/services/text-gen.js';
import { ProBackendManager } from './backends.js';
import type { ProConfig } from './config.js';
import { ComfyEngine } from './engines/comfy.js';
import { AnalyzeEngine } from './engines/analyze.js';
import { RenderEngine } from './engines/render.js';
import { registerProTools } from './mcp/tools.js';
import { buildPaths, ensureDirs, type ProPaths } from './paths.js';
import { ProjectService } from './projects/service.js';
import { PRO_MIGRATIONS, PRO_SCHEMA_SQL } from './projects/schema.js';
import { analyzeRoutes } from './routes/analyze.js';
import { projectRoutes } from './routes/projects.js';
import { DOWNLOAD_KINDS, comfyLayout, type DownloadKind, type DownloadSlot } from './recipes/layout.js';
import { RecipeStore } from './recipes/store.js';
import { generateRoutes } from './routes/generate.js';
import { recipeRoutes } from './routes/recipes.js';

export const VERSION = '0.1.0';

export interface ProServer {
  app: FastifyInstance;
  paths: ProPaths;
  jobs: JobManager;
  downloads: DownloadManager<DownloadKind, DownloadSlot>;
  backends: ProBackendManager;
  engines: EngineRegistry;
  recipes: RecipeStore;
  comfy: ComfyEngine;
  projects: ProjectService;
  closeDb: () => void;
}

export async function buildServer(config: ProConfig): Promise<ProServer> {
  const paths = buildPaths(config);
  await ensureDirs(paths);

  const { app, logs, db, settings, activity, closeDb } = await createCoreApp({
    config,
    paths,
    product: {
      title: 'Pepper Pro API',
      description: 'Production image, video and audio through ComfyUI recipes, organised as projects, shots and takes.',
      version: VERSION,
      tags: [
        { name: 'recipes', description: 'Pinned ComfyUI recipes and their install state' },
        { name: 'projects', description: 'Projects, assets, shots, takes and cuts' },
        { name: 'text', description: 'llama.cpp text generation' },
      ],
    },
    schema: { name: 'pepper-pro', sql: PRO_SCHEMA_SQL, migrations: PRO_MIGRATIONS },
  });

  // --- Services -------------------------------------------------------------

  const recipes = new RecipeStore(config.recipesDir, paths, app.log);
  await recipes.load();
  const backends = new ProBackendManager(config, paths, settings, app.log, logs, () =>
    recipes.list().flatMap((recipe) => recipe.nodes.map((pack) => pack.name)),
  );
  const storage = new StorageMonitor(paths.dataDir, config.dataVolumeGb ? config.dataVolumeGb * 1024 ** 3 : null);

  const downloads = new DownloadManager<DownloadKind, DownloadSlot>(
    config,
    db,
    comfyLayout(paths),
    app.log,
    storage,
    (task) => {
      // llama.cpp scans its model folder at startup; ComfyUI rescans its own
      // folders per request, so only the LLM needs a restart.
      if (task.status === 'completed' && task.kind === 'llm') backends.scheduleRestart('llamacpp', 'llm model downloaded');
    },
  );

  const jobs = new JobManager(config, db, app.log, logs);
  const engines = new EngineRegistry(app.log);
  const comfy = new ComfyEngine({ config, paths, backends, recipes, memory: engines, log: app.log });
  const text = new TextService(config, backends, app.log, logs);
  const projects = new ProjectService({ db, jobs, comfy, recipes, paths, config, log: app.log });

  engines
    .register(comfy)
    .register(
      processEngine(backends, 'llamacpp', 'llama.cpp', {
        text: async (context) => {
          const result = await text.generate({
            params: context.job.params as never,
            signal: context.signal,
            onLog: context.onLog,
          });
          return {
            text: result.text,
            metadata: {
              kind: 'text',
              model: result.params.model,
              usage: result.usage,
              finish_reason: result.finishReason,
              duration_ms: result.durationMs,
            },
          };
        },
      }),
    )
    .register(new RenderEngine({ paths, projects, log: app.log }))
    .register(new AnalyzeEngine({ config, paths, projects, recipes, text, log: app.log }));
  engines.attach(jobs);

  const resources = new ResourceMonitor();

  // --- Routes ---------------------------------------------------------------

  await app.register(authRoutes, { apiToken: config.apiToken });
  await app.register(systemRoutes, {
    version: VERSION,
    config,
    paths,
    backends,
    engines,
    jobs,
    downloads,
    resources,
    storage,
    activity,
    status: async () => ({
      product: 'pepper-pro',
      tier: config.tier,
      licence_mode: config.licenceMode,
      recipes: { total: recipes.list().length, broken: recipes.broken.length },
    }),
  });
  await app.register(coreJobRoutes, { jobs });
  await app.register(generateRoutes, { jobs, comfy, backends, paths, llamacppTimeoutMs: config.llamacppTimeoutMs });
  await app.register(recipeRoutes, { config, recipes, downloads });
  await app.register(projectRoutes, { projects });
  await app.register(analyzeRoutes, { jobs, projects });
  await app.register(mediaRoutes, { paths, jobs });
  await app.register(downloadRoutes, { downloads, kinds: DOWNLOAD_KINDS });
  await app.register(logRoutes, { logs, backendSources: backends.ids() });
  await app.register(mcpRoutes, {
    name: 'pepper-pro',
    version: VERSION,
    port: config.port,
    context: { apiToken: config.apiToken, jobs, outputDir: paths.outputDir, uploadsDir: paths.uploadsDir },
    register: registerProTools,
  });

  await serveSpa(app, join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

  return { app, paths, jobs, downloads, backends, engines, recipes, comfy, projects, closeDb };
}
