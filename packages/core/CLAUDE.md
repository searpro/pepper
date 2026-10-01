# packages/core — what both products run on

Loaded when working under `packages/core/`. Root `CLAUDE.md` has commands and layout.

Imported as `@pepper/core/<path>.js`. During development the `pepper-source`
export condition resolves that to `src/*.ts` (tsx, vitest and typecheck all
set it); a build resolves it to `dist/`, so **build core before building an
app** (`npm run build -w @pepper/core`; the root `build` scripts do).

- Nothing here may import from an app. Product-specific behaviour comes in
  through options: route plugins take their dependencies as Fastify options
  (`systemRoutes({ version, config, paths, backends, engines, … })`), services
  through their constructors.
- `app.ts`: `createCoreApp` (Fastify, zod, swagger, websocket, multipart,
  auth) and `serveSpa`. It carries `/// <reference types … preserve="true" />`
  for the plugins, so the emitted declarations keep their type augmentations;
  keep those lines.
- `engines/engine.ts`: the `Engine` seam and `EngineRegistry`, which owns the
  job kinds and GPU arbitration (`exclusive()` releases every other engine).
  `processEngine` wraps a supervised backend as an engine.
- `backends/manager.ts`: `BackendManager` is generic over
  `BackendDefinition`s (arg spec, installer, health path, a `prepare` hook);
  apps supply theirs. `llama.ts` is llama.cpp's definition, shared.
- `db/client.ts`: `openDb(file, onRecovered, product)` creates core's tables
  and the product's (`ProductSchema{ name, sql, migrations }`), each list of
  migrations counted separately in `schema_versions`.
- `downloads/manager.ts` is generic over a `DownloadLayout` (where a kind of
  file lives); Pepper's bundle layout and Pro's ComfyUI folders are two layouts.
- `mcp/kit.ts`: the helpers every tool uses (`call`, `submit`, `waitForJob`,
  `jobsResult`) and the shared registrars (`registerJobTools`,
  `registerInputTool`, `registerLogTool`, `registerMediaResources`).
- `util/ffmpeg.ts`: `probeMedia` and `runFfmpegTracked` (progress from ffmpeg's
  own clock) are what Pro's cut render uses; keep them product-neutral.

A change here changes both products: run both test suites (`npm test`) and
the full typecheck.
