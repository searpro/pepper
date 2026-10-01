# Pepper

Media generation API (image, video, speech, music, text) wrapping
`stable-diffusion.cpp` (sd-cli), `llama.cpp`, `audio.cpp`, vLLM and Python
runners, plus a React SPA and an MCP endpoint (`/mcp`) served by the same
Fastify process. Alpha successor to sd-api; the sd-api contract must keep
working (`docs/API-COMPATIBILITY.md`).

One user, one shared secret (`PEPPER_API_TOKEN`). The target is quality media
at low cost on a 24 GB RunPod pod, driven from the web app or from Claude over
MCP.

Two products on one platform, as npm workspaces:

| Workspace | What |
| --- | --- |
| `packages/core` (`@pepper/core`) | What both run on: jobs, downloads, logs, SQLite, auth, media, backend supervision, the `Engine` seam, llama.cpp, the MCP transport and toolkit |
| `packages/ui` (`@pepper/ui`) | Shared React: shell, primitives, sign-in, status, backend settings, Jobs, Logs, API client |
| `apps/pepper/server`, `apps/pepper/web` | **Pepper**: the lightweight product above (sd-cli, llama.cpp, audio.cpp, vLLM, Python runners); local, Kaggle or a 24 GB pod |
| `apps/pepper-pro/server`, `apps/pepper-pro/web` | **Pepper Pro**: production media through ComfyUI recipes, organised as projects → scenes → shots → takes → a cut (`docs/PEPPER-PRO.md`) |

Each workspace has its own `CLAUDE.md` with details. Apps import core as
`@pepper/core/<path>.js` (source in dev through the `pepper-source` export
condition, `dist/` in a build).

## Commands

```bash
npm run typecheck                      # every workspace; run after any TS change
npm test                               # vitest: Pepper's then Pepper Pro's suite
cd apps/pepper/server && npx vitest run -t "model bundles"   # one describe block, cheaper than the full run
npm run dev                            # Pepper's API on :3000 (tsx watch, loads apps/pepper/server/.env)
npm run dev:web                        # Pepper's SPA on :5173, proxies /v1 and /health to PEPPER_API (default :3000)
npm run build                          # core, then Pepper's web -> apps/pepper/server/public, then its server
npm run dev:pro / dev:pro-web / build:pro                    # the same for Pepper Pro
npm run validate-recipes -w @pepper-pro/server -- --comfy URL # recipes against a live ComfyUI
```

There is no linter or formatter configured; match the surrounding style
(2-space indent, single quotes, semicolons, trailing commas).

## Where things live

| Path | What |
| --- | --- |
| `apps/pepper/server/src/routes/*` | Pepper's Fastify plugins, registered in its `server.ts`; shared ones (jobs, media, downloads, logs, system, MCP) are `packages/core/src/routes/*` |
| `apps/pepper/server/src/services/*` | Image (sd-cli spawn, hires pass, LoRA schedules), speech and music, image and video upscale, characters, S2V, Python tasks |
| `apps/pepper/server/src/engines/pepper.ts` | Pepper's backends as engines; `packages/core/src/engines/engine.ts` arbitrates the GPU between them |
| `packages/core/src/auth.ts` | The token check: Bearer header, session cookie or `/mcp/<token>` |
| `apps/*/server/src/mcp/tools.ts` | Each product's MCP tools; `packages/core/src/mcp/kit.ts` has the shared helpers and tools |
| `packages/core/src/backends/*`, `apps/pepper/server/src/backends/*` | `BackendManager`, `ManagedProcess` supervision, binary installer; Pepper's CLI arg tables |
| `apps/pepper/server/src/models/bundle.ts` | Model bundle layout / slot detection |
| `packages/core/src/jobs`, `downloads`, `logs`, `db` | Persistent job queue, resumable downloads, log buffer, SQLite |
| `apps/pepper/server/python/pepper_runner` | One-shot Python runners (Wan 2.2 5B, LTX, EchoMimicV3, upscale, SeedVR2, YuE2) |
| `apps/pepper-pro/server/src/{comfy,engines,recipes,projects,golden}` | ComfyUI client and graph editing, the ComfyUI/render/analyze engines, recipes, projects, golden shots |
| `apps/pepper-pro/server/recipes/<id>/` | Recipes: `recipe.json` plus ComfyUI API-format workflows; `recipes/README.md` is the contract |
| `apps/*/web/src/pages/*`, `packages/ui/src/*` | SPA screens; `packages/ui/src/lib/api.ts` is the API client |
| `deploy/runpod` | RunPod launcher (`launch.py` local; `--product pro --tier …` for Pro) and container `entrypoint.mjs` (tunnel, idle shutdown) |
| `deploy/kaggle` | Kaggle GPU launcher (`launch.py` local, `kernel.py` remote); free, 16 GB; Pepper only |
| `Dockerfile`, `Dockerfile.pro`, `.github/workflows/*.yml` | The images pods run (`ghcr.io/searpro/pepper`, `…/pepper-pro`), rebuilt on pushes to `main`; `test.yml` runs typecheck and tests |
| `.mcp.json`, `.claude/pepper-mcp.mjs` | Claude Code's `pepper` MCP server: a stdio bridge to a running instance |
| `.claude/skills/*` | `pepper-dev` (change → local checks → GPU) and `catalogue-curator` (research → entry → test → PR) |
| `docs/ARCHITECTURE.md` | Design reasons, **Gotchas** and **Conventions** (grep `^## ` for the line) |
| `docs/CATALOGUE.md` | Pepper's remote catalogue manifest format (catalogue lives in searpro/pepper-catalogue) |
| `docs/PRODUCTION-VIDEO.md` | Research behind Pepper Pro: models, recipes, projects |
| `docs/PEPPER-PRO.md` | Pepper Pro's design, and what is built and verified so far (§13) |
| `docs/MCP.md` | Using Pepper Pro's MCP endpoint from another project: connect, tools, a video end to end |

## Conventions (short form — full list in docs/ARCHITECTURE.md)

- A route is `export async function xRoutes(fastify, options)` with a zod
  `schema` (tags + summary) so `/docs` stays useful; register it in the app's
  `server.ts`. Core code never imports an app: it takes what it needs as options.
- Services get dependencies via constructor and are decorated onto the app once.
- Reuse `errors.*`, `safeResolve`/`assertSafeName`, `parseBackendLine`,
  `Semaphore`, and `DownloadManager` rather than re-implementing them.
- Abortable/retryable/deletable state goes in SQLite; anything describing files
  on disk is read from disk.
- Server imports use `.js` suffixes (NodeNext ESM); web imports use the `@/`
  alias for the app and `@pepper/ui/...` for shared components.
- Comments explain *why*, in full sentences; keep that density.
- A capability Claude should be able to use needs an MCP tool or parameter in
  the product's `src/mcp/tools.ts` as well as the route. Keep tools few and
  descriptions short (they sit in every conversation), and never let one wait
  past 50 s: long work returns a job id for `get_job`.
- Pepper's catalogue is a separate repo (`../pepper-catalogue`); changes go
  through a PR the user merges, never a push to its `main`. Pepper Pro's
  recipes ship in this repo and its image instead (a recipe pins node packs,
  which are an image change anyway).

## Working efficiently in this repo

- **Never read or search `apps/*/server/data/`, `data/`** (tens of GB of models
  and binaries), `node_modules/`, `apps/*/server/public/`, `*/dist/`,
  `package-lock.json` or `docs/media/*.png`. `.claude/settings.json` denies them.
- Several files are 1,000–1,800 lines (`apps/pepper/web/src/pages/Image.tsx`,
  `Generate.tsx`, `Characters.tsx`, each app's `server/test/unit.test.ts`). Grep
  for the symbol first, then `Read` with `offset`/`limit` instead of the whole file.
- Tests are grouped by `describe('<area>')` in each app's `test/unit.test.ts`;
  find the block with `grep -n "describe('" apps/<app>/server/test/unit.test.ts`
  and run just that block.
- Read the relevant ARCHITECTURE section rather than the whole doc.
- Backend binaries (sd-cli, llama-server, audiocpp) are usually absent locally,
  so generation can't be exercised end-to-end on a Mac; verify with typecheck +
  unit tests + the UI, and say so. Pepper Pro's engine can be exercised on a
  CPU ComfyUI with the model-free fixture recipes (its `CLAUDE.md` says how);
  its real recipes need a GPU.

## Running on a GPU

The `pepper-dev` skill has the full loop. In short:

- `uv run deploy/runpod/launch.py up | status | logs | down` — a pod runs the
  *published image*, so a change must be pushed and the `image` (or
  `image-pro`) workflow finished first. Pods bill per second: ask before `up`,
  and `down` when done. `up --product pro --tier 24gb-64ram|32gb|48gb|96gb`
  starts Pepper Pro on a matching GPU and host RAM.
- `uv run deploy/kaggle/launch.py --hours 2 --packs starter` — free, runs the
  checkout including uncommitted changes, but only 16 GB.
- Both serve one hostname through one named tunnel; never run two at once.
- The `pepper` MCP server (`.mcp.json`) reaches whichever is running. Its
  bridge reads the hostname and token from `deploy/runpod/.env` /
  `deploy/kaggle/.env`; `PEPPER_URL=http://localhost:3000` points it at a
  local server instead. If it failed to connect, no instance was running.
- On a 24 GB pod system RAM (31–46 GB), not VRAM, limits a model set; see
  `deploy/runpod/README.md` for measured sizes and timings.

## Environment

- Config is env-driven (`apps/*/server/src/config.ts` over core's
  `packages/core/src/config.ts`, annotated in `apps/*/server/.env.example`).
  `apps/*/server/.env` is gitignored and may hold secrets — don't print it.
- `deploy/kaggle/.env` and `deploy/runpod/.env` hold the API token, the tunnel
  token and the RunPod key. They are denied to `Read`; never print them, copy
  them into commands, or write to them — tell the user what to add instead.
- With `PEPPER_API_TOKEN` set, `/v1/*`, `/mcp` and `/docs` need it; unset (local
  dev), the server is open.
- Default release repos are Linux-CUDA-only forks; local macOS dev needs
  `SDCPP_RELEASE_REPO=leejet/stable-diffusion.cpp` and
  `LLAMACPP_RELEASE_REPO=ggml-org/llama.cpp`.
- The preview config in `.claude/launch.json` runs Pepper's web dev server
  against an API on :3004 (`web`), and Pepper Pro's against :3014 (`pro-web`).
