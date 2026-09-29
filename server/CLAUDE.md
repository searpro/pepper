# server/ — Fastify API

Loaded when working under `server/`. Root `CLAUDE.md` has commands and layout.

- Entry: `src/index.ts` loads config, builds the app (`src/server.ts`), listens,
  *then* installs backends in the background. Never block `listen` on installs.
- Services are built in `server.ts` and `app.decorate(...)`d; their Fastify types
  are declared in `src/types.ts` (`declare module 'fastify'`). A new service
  needs both.
- New route: plugin in `src/routes/`, zod `schema` with tags/summary, register in
  `server.ts`. Watch for collisions with the sd-api legacy routes in
  `routes/compat.ts` (e.g. no `/v1/models/:kind`; use `?kind=`).
- Errors: throw `errors.*` from `src/errors.ts`; sd-api error codes are
  wire-compatible and must not be renamed.
- Paths from user input go through `safeResolve` / `assertSafeName` (`src/paths.ts`).
- SQLite schema is created in `src/db/client.ts` (no drizzle-kit migrations). A new
  column needs an `ALTER TABLE` entry in `MIGRATIONS` there as well as
  `src/db/schema.ts`.
- Backend CLI flags are data tables in `src/backends/args.ts`, not string building.
- sd-cli exits 0 even when it wrote nothing — stat and size-check outputs.
- Python runners: `python/pepper_runner`, one job JSON in, protocol lines out
  (`common.emit`), registered in `runners/__init__.py:RUNNERS`. Deps pinned in
  `python/requirements.txt`; bump together.

## Tests

Single file `test/unit.test.ts` (~1,400 lines, vitest). Add tests to the matching
`describe('<area>')` block; run only that block:

```bash
npx vitest run -t "backend CLI arguments"
```

Keep the file plain text: write binary fixtures with `\x00`-style escapes, never
literal control bytes, or search tools treat the whole file as binary.
