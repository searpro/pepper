# apps/pepper/server — Pepper's API

Loaded when working under `apps/pepper/server/`. Root `CLAUDE.md` has commands and layout.
Anything both products share (jobs, downloads, logs, auth, media, the MCP
transport and toolkit, backend supervision, engines) is in `packages/core`,
imported as `@pepper/core/<path>.js`; see `packages/core/CLAUDE.md`.

- Entry: `src/index.ts` loads config, builds the app (`src/server.ts`), listens,
  *then* installs backends in the background. Never block `listen` on installs.
- Services are built in `server.ts` and `app.decorate(...)`d; their Fastify types
  are declared in `src/types.ts` (`declare module 'fastify'`). A new service
  needs both.
- New route: plugin in `src/routes/`, zod `schema` with tags/summary, register in
  `server.ts`. Watch for collisions with the sd-api legacy routes in
  `routes/compat.ts` (e.g. no `/v1/models/:kind`; use `?kind=`).
- Errors: throw `errors.*` from `@pepper/core/errors.js`; sd-api error codes are
  wire-compatible and must not be renamed.
- Paths from user input go through `safeResolve` / `assertSafeName` (`@pepper/core/paths.js`).
- SQLite: core creates the shared tables (`packages/core/src/db/client.ts`);
  Pepper's own (characters) are `PEPPER_SCHEMA_SQL` in `src/db/schema.ts`. A
  new column needs an `ALTER TABLE` in the owning migrations list (core's
  `CORE_MIGRATIONS` or `PEPPER_MIGRATIONS`) as well as the drizzle table.
- Backend CLI flags are data tables in `src/backends/args.ts` (llama.cpp's in
  `@pepper/core/llama.js`), not string building. Each backend runs behind an
  `Engine` (`src/engines/pepper.ts`); memory arbitration is core's `EngineRegistry`.
- sd-cli exits 0 even when it wrote nothing — stat and size-check outputs.
- Python runners: `python/pepper_runner`, one job JSON in, protocol lines out
  (`common.emit`), registered in `runners/__init__.py:RUNNERS`. Deps pinned in
  `python/requirements.txt`; bump together. The image bakes that environment
  at `PYTHON_DIR` (`src/scripts/install-python.ts`), because installing onto
  a network volume at run time takes 20+ minutes — a new dependency is an
  image change. A runner whose pins conflict with it gets an isolated venv
  (`ensureIsolatedEnvironment`, as YuE2 does), built on first use.
- Runners are spawned with `HF_HUB_OFFLINE=1` unless the task opts out; weights
  belong in the bundle as catalogue components, not in a run-time download.
- Auth (`@pepper/core/auth.js`) is a root `onRequest` hook registered *before* the
  plugins so it covers `/docs` too. There is no loopback exemption: the tunnel
  connects from 127.0.0.1. `requiresAuth` guards `/v1/*`, `/mcp` and `/docs`; a route
  outside those prefixes is public unless it is added there.
- MCP (core's `routes/mcp.ts`, Pepper's tools in `src/mcp/tools.ts`, helpers
  in `@pepper/core/mcp/kit.js`): stateless, a fresh server per
  POST, tools call the HTTP API through `app.inject`. When a route gains a
  parameter Claude should use, add it to the tool's schema too, and to the
  `mcp` tests. Only `tools/call` counts as activity (core's `services/activity.ts`);
  the RunPod idle shutdown depends on that.
- Media tools carry `_meta: SHOWS_MEDIA`, which makes Claude render
  core's `mcp/media-view.ts` in the chat. That file is one HTML document inside a
  `String.raw` template: keep its script free of backticks and `${`. The view
  draws `structuredContent.jobs` (`viewJob`); a new kind of output needs a
  case there and in the view's `card()`. There is no claude.ai in the test
  loop, so check changes against a local host harness before deploying.
- `openDb` uses `locking_mode = EXCLUSIVE` on purpose (a full network volume
  otherwise kills the process with SIGBUS); never open a second connection.
- Model defaults come from the catalogue entry via `model.json`
  (`models/bundle.ts`): scheduler, sigmas, default LoRAs, `high_noise`,
  `hires`. `services/image-args.ts` merges them under the request; a LoRA
  preset's schedule suppresses the default hires pass.
- Music: audio.cpp task `gen` via `/v1/tasks/run` (`services/audio-gen.ts`);
  request fields differ per family (`musicRequest`). audio.cpp models load
  lazily, and a Python-backend audio download must not restart audio.cpp.
- `openDb` quarantines a corrupt database (`.corrupt-<ts>`) and starts fresh
  rather than refusing to boot; a full volume is how that happens.

## Tests

Single file `test/unit.test.ts` (~1,800 lines, vitest). Add tests to the matching
`describe('<area>')` block; run only that block:

```bash
npx vitest run -t "backend CLI arguments"
```

Keep the file plain text: write binary fixtures with `\x00`-style escapes, never
literal control bytes, or search tools treat the whole file as binary.
