# Pepper

Media generation API (image, video, audio, text) wrapping `stable-diffusion.cpp`
(sd-cli), `llama.cpp`, `audio.cpp`, vLLM and Python video runners, plus a React
SPA served by the same Fastify process. Alpha successor to sd-api; the sd-api
contract must keep working (`docs/API-COMPATIBILITY.md`).

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
| `server/src/services/*` | Image (sd-cli spawn), text, audio, upscale, characters, S2V, Python video |
| `server/src/backends/*` | `BackendManager`, `ManagedProcess` supervision, binary installer, CLI arg tables |
| `server/src/models/bundle.ts` | Model bundle layout / slot detection |
| `server/src/jobs`, `downloads`, `catalogue`, `logs`, `db` | Persistent job queue, resumable downloads, remote catalogue, log buffer, SQLite |
| `server/python/pepper_runner` | One-shot Python runners (Wan 2.2, LTX, EchoMimicV3, upscale) |
| `web/src/pages/*`, `web/src/components/*` | SPA screens; `web/src/lib/api.ts` is the API client |
| `deploy/kaggle` | Kaggle GPU launcher (`launch.py` local, `kernel.py` remote) |
| `docs/ARCHITECTURE.md` | Design reasons, **Gotchas** (§ line ~296) and **Conventions** (§ line ~355) |
| `docs/CATALOGUE.md` | Remote catalogue manifest format (catalogue lives in searpro/pepper-catalogue) |

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

## Environment

- Config is env-driven (`server/src/config.ts`, annotated in `server/.env.example`).
  `server/.env` is gitignored and may hold secrets — don't print it.
- Default release repos are Linux-CUDA-only forks; local macOS dev needs
  `SDCPP_RELEASE_REPO=leejet/stable-diffusion.cpp` and
  `LLAMACPP_RELEASE_REPO=ggml-org/llama.cpp`.
- The preview config in `.claude/launch.json` runs the web dev server against an
  API on :3004.
