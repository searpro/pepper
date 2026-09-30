# Pepper

Media generation API (image, video, speech, music, text) wrapping
`stable-diffusion.cpp` (sd-cli), `llama.cpp`, `audio.cpp`, vLLM and Python
runners, plus a React SPA and an MCP endpoint (`/mcp`) served by the same
Fastify process. Alpha successor to sd-api; the sd-api contract must keep
working (`docs/API-COMPATIBILITY.md`).

One user, one shared secret (`PEPPER_API_TOKEN`). The target is quality media
at low cost on a 24 GB RunPod pod, driven from the web app or from Claude over
MCP.

npm workspaces: `server/` (Fastify + TypeScript + SQLite/drizzle) and `web/`
(React 19 + Vite + Tailwind 4). Each has its own `CLAUDE.md` with details.

## Commands

```bash
npm run typecheck                      # server + web; run after any TS change
npm test                               # vitest, server only (one file: server/test/unit.test.ts)
cd server && npx vitest run -t "model bundles"   # one describe block, cheaper than the full run
npm run dev                            # API on :3000 (tsx watch, loads server/.env)
npm run dev:web                        # SPA on :5173, proxies /v1 and /health to PEPPER_API (default :3000)
npm run build                          # web -> server/public, then server -> server/dist
```

There is no linter or formatter configured; match the surrounding style
(2-space indent, single quotes, semicolons, trailing commas).

## Where things live

| Path | What |
| --- | --- |
| `server/src/routes/*` | One Fastify plugin per area, registered in `server/src/server.ts` |
| `server/src/services/*` | Image (sd-cli spawn, hires pass, LoRA schedules), text, speech and music, image and video upscale, characters, S2V, Python tasks, activity (idle) tracking |
| `server/src/auth.ts` | The token check: Bearer header, session cookie or `/mcp/<token>` |
| `server/src/mcp/tools.ts`, `routes/mcp.ts` | The MCP tools Claude uses; each wraps the HTTP API through `app.inject` |
| `server/src/backends/*` | `BackendManager`, `ManagedProcess` supervision, binary installer, CLI arg tables |
| `server/src/models/bundle.ts` | Model bundle layout / slot detection |
| `server/src/jobs`, `downloads`, `catalogue`, `logs`, `db` | Persistent job queue, resumable downloads, remote catalogue, log buffer, SQLite |
| `server/python/pepper_runner` | One-shot Python runners (Wan 2.2 5B, LTX, EchoMimicV3, upscale, SeedVR2, YuE2) |
| `web/src/pages/*`, `web/src/components/*` | SPA screens; `web/src/lib/api.ts` is the API client |
| `deploy/runpod` | RunPod launcher (`launch.py` local) and container `entrypoint.mjs` (tunnel, idle shutdown); the default GPU target |
| `deploy/kaggle` | Kaggle GPU launcher (`launch.py` local, `kernel.py` remote); free, 16 GB |
| `Dockerfile`, `.github/workflows/image.yml` | The image pods run (`ghcr.io/searpro/pepper`), rebuilt on every push to `main` that touches the app |
| `.mcp.json`, `.claude/pepper-mcp.mjs` | Claude Code's `pepper` MCP server: a stdio bridge to a running instance |
| `.claude/skills/*` | `pepper-dev` (change → local checks → GPU) and `catalogue-curator` (research → entry → test → PR) |
| `docs/ARCHITECTURE.md` | Design reasons, **Gotchas** and **Conventions** (grep `^## ` for the line) |
| `docs/CATALOGUE.md` | Remote catalogue manifest format (catalogue lives in searpro/pepper-catalogue) |
| `docs/PRODUCTION-VIDEO.md` | Research and roadmap for production-quality video (models, recipes, ComfyUI engine, projects) |
| `docs/PEPPER-PRO.md` | Proposal for Pepper Pro: a ComfyUI-only production product on a shared core |

## Conventions (short form — full list in docs/ARCHITECTURE.md)

- A route is `export async function xRoutes(fastify)` with a zod `schema`
  (tags + summary) so `/docs` stays useful; register it in `server.ts`.
- Services get dependencies via constructor and are decorated onto the app once.
- Reuse `errors.*`, `safeResolve`/`assertSafeName`, `parseBackendLine`,
  `Semaphore`, and `DownloadManager` rather than re-implementing them.
- Abortable/retryable/deletable state goes in SQLite; anything describing files
  on disk is read from disk.
- Server imports use `.js` suffixes (NodeNext ESM); web imports use the `@/` alias.
- Comments explain *why*, in full sentences; keep that density.
- A capability Claude should be able to use needs an MCP tool or parameter in
  `server/src/mcp/tools.ts` as well as the route. Keep tools few and
  descriptions short (they sit in every conversation), and never let one wait
  past 50 s: long work returns a job id for `get_job`.
- The catalogue is a separate repo (`../pepper-catalogue`); changes go through
  a PR the user merges, never a push to its `main`.

## Working efficiently in this repo

- **Never read or search `server/data/`, `data/`** (tens of GB of models and
  binaries), `node_modules/`, `server/public/`, `server/dist/`,
  `package-lock.json` or `docs/media/*.png`. `.claude/settings.json` denies them.
- Several files are 1,000–1,600 lines (`web/src/pages/Image.tsx`,
  `Generate.tsx`, `Characters.tsx`, `server/test/unit.test.ts`). Grep for the
  symbol first, then `Read` with `offset`/`limit` instead of the whole file.
- Tests are grouped by `describe('<area>')` in `unit.test.ts`; find the block with
  `grep -n "describe('" server/test/unit.test.ts` and run just that block.
- Read the relevant ARCHITECTURE section rather than the whole doc.
- Backend binaries (sd-cli, llama-server, audiocpp) are usually absent locally,
  so generation can't be exercised end-to-end on a Mac; verify with typecheck +
  unit tests + the UI, and say so.

## Running on a GPU

The `pepper-dev` skill has the full loop. In short:

- `uv run deploy/runpod/launch.py up | status | logs | down` — a pod runs the
  *published image*, so a change must be pushed and the `image` workflow
  finished first. Pods bill per second: ask before `up`, and `down` when done.
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

- Config is env-driven (`server/src/config.ts`, annotated in `server/.env.example`).
  `server/.env` is gitignored and may hold secrets — don't print it.
- `deploy/kaggle/.env` and `deploy/runpod/.env` hold the API token, the tunnel
  token and the RunPod key. They are denied to `Read`; never print them, copy
  them into commands, or write to them — tell the user what to add instead.
- With `PEPPER_API_TOKEN` set, `/v1/*`, `/mcp` and `/docs` need it; unset (local
  dev), the server is open.
- Default release repos are Linux-CUDA-only forks; local macOS dev needs
  `SDCPP_RELEASE_REPO=leejet/stable-diffusion.cpp` and
  `LLAMACPP_RELEASE_REPO=ggml-org/llama.cpp`.
- The preview config in `.claude/launch.json` runs the web dev server against an
  API on :3004.
