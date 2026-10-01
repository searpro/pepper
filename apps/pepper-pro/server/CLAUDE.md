# apps/pepper-pro/server — Pepper Pro's API

Loaded when working under `apps/pepper-pro/server/`. Root `CLAUDE.md` has
commands and layout; `docs/PEPPER-PRO.md` has the design.

ComfyUI is the only generative engine, llama.cpp does text, ffmpeg cuts.
Everything else (jobs, downloads, logs, auth, media, MCP) is `@pepper/core`.

- `src/comfy/`: `client.ts` speaks ComfyUI's HTTP and websocket API;
  `graph.ts` edits API-format prompts: `setInput`, `prune` (a removed node
  takes with it whatever needed it through a required input; optional inputs
  and growable-group slots are just dropped), `applyBypasses`,
  `retainReachable`, `validatePrompt` (classes, required inputs, link types,
  choices).
- `src/recipes/`: the recipe format (`schema.ts`), loading and install state
  (`store.ts`, read from disk every time), and `check.ts`, which builds every
  mode with and without its optional inputs. Recipes live in `recipes/<id>/`
  and ship with the image; their parameter names are a contract with
  projects (`recipes/README.md`).
- `src/engines/`: `build.ts` turns a recipe mode plus values into a prompt;
  `comfy.ts` runs one prompt at a time (ComfyUI's interrupt is global), frees
  models on a family switch, recycles ComfyUI after N jobs; `render.ts` cuts
  with ffmpeg; `analyze.ts` runs `python/analyze.py` (beats, stems) on the
  CPU and vision checks through llama.cpp.
- `src/projects/`: tables (`schema.ts`), shot → recipe parameters
  (`derive.ts`, by parameter name), and `service.ts` (takes are jobs; a
  finished take's file is copied into the project). `chain.ts` plans long
  takes and retakes: segments continuing each other through a recipe's
  `continuation` input, driven by the service one job at a time (a parent
  job waiting on its children would hold the only job slot) and joined with
  ffmpeg.
- `src/golden/`: golden-shot runs and the blind A/B (`golden/shots.json`).
- `src/mcp/tools.ts`: Claude's tools. Keep them few: pro_status,
  list_recipes, install_recipe, generate, plan_project, render_shots,
  get_project, analyze, plus core's job/input/log tools. None waits past 50 s.
- A new column is an `ALTER TABLE` in `PRO_MIGRATIONS` (fresh databases run
  every migration, so do not also add it to `PRO_SCHEMA_SQL`); a new table is
  a `CREATE TABLE IF NOT EXISTS` in the schema SQL.
- Every job gives its save nodes a unique `filename_prefix`: ComfyUI caches
  an unchanged node and reports its previous file, which an earlier job has
  already moved out.

## Recipes

Change a recipe, then run `npm run validate-recipes -- --comfy <url>
--write-fixture test/fixtures/object_info.json` against a ComfyUI that has
the pinned version (scripts/install-comfy.sh installs one; `TORCH_INDEX=
https://download.pytorch.org/whl/cpu` for a CPU-only checkout). The unit
tests then validate every recipe offline against that fixture. Nothing here
has been run on a GPU until a recipe's `verified` is filled in by a golden
run on a pod.

## Tests

`test/unit.test.ts`, grouped by `describe('<area>')`. The `comfyui end to
end` block runs only with `COMFY_TEST_DIR` and `COMFY_TEST_PYTHON` set (a CPU
ComfyUI is enough; the fixture recipes in `test/fixtures/recipes` need no
models).
