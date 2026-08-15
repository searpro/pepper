# Architecture

Design reference for pepper. `README.md` covers configuration and running it;
this covers how it is put together and, where it differs from sd-api, why.

## Shape

```
HTTP (server/src/routes/*)
  ↓
Services decorated on the Fastify instance
  ↓
BackendManager ──► ManagedProcess ──► llama-server / audiocpp_server / python
  │                                    (long-running, supervised)
  ├──► BinaryInstaller ──────────────► GitHub releases
  └──► ImageService ─────────────────► sd-cli (one-shot, per generation)

JobManager · DownloadManager · ModelManager · CatalogueManager · LogBuffer
  ↓
SQLite (jobs, downloads, settings) · filesystem (models, outputs, uploads)
```

`server/src/index.ts` loads config, builds the server, **starts listening**, and
only then converges backends in the background. That ordering is deliberate: a
cold start downloads hundreds of megabytes, and blocking the listen on it means
the orchestrator's health check fails for minutes and kills the container —
repeatedly, never finishing the download it keeps restarting.

## What changed from sd-api, and why

sd-api worked. These are the places where making it production-ready meant
changing the design rather than hardening the code.

### One process manager, not three

sd-api had `SdWrapper`, `LlamaServerManager` and `AudioServerManager`; its own
architecture doc describes the last two as "copied almost line-for-line". Every
fix to the startup race or the stop sequence had to land three times, and the
audio one drifted anyway.

Here the shared behaviour — install, spawn, health-poll, log, recycle, stop —
lives in `ManagedProcess`, and the differences are data: an argument spec, a
health path, and an optional `prepare` hook. `BackendManager` owns the table.

`sd-cli` stays outside it: it is a one-shot CLI spawned per generation, so
there is no long-running process to keep single, monitor, or restart.
`ImageService` owns that spawn and shares everything downstream of it (the line
parser, the log buffer, the job queue).

### Backends are recycled on swap, not on memory use

Requirement 5 named the symptom: "the audio-cpp-server is swapping". The fix
depends on distinguishing two states that look identical in RSS. A backend
holding 12GB resident is doing its job. A backend whose pages the kernel has
pushed to disk is thrashing — every inference faults them back in, a two-second
request takes ninety, and nothing shrinks the footprint on its own.

Only `VmSwap` separates them, so `monitor.ts` reads `/proc/<pid>/status` and the
policy triggers on swap, plus a conjunctive idle rule (idle **and** holding
memory — either alone is a normal state). macOS cannot report per-process swap
without elevated privileges, so `swapKb` is `null` there and the idle rule
carries; production is Linux/CUDA, where the precise signal exists.

### CLI arguments are data

Requirement 5: "never hardcode CLI args". Each backend declares its arguments —
key, flag, type, and sd-api's working value as the seed — in
`backends/args.ts`. That declaration is what the Preferences screen renders a
form from (no per-backend UI code) and what `renderArgs()` turns into argv. User
overrides live in SQLite, so retuning `-c` or `-ngl` is a settings write rather
than a redeploy.

Two escape hatches keep it from being a cage: `extraArgs` appends anything the
schema does not model, and a `null` override drops an argument entirely — which
is how "let the backend decide" is expressed. sd-api used a `-1` sentinel for
`-ngl`, which only worked because that flag happened to have an impossible
value to spare.

`--host`, `--port` and the models directory are marked `locked` and computed at
spawn time. These processes have no authentication of their own, so binding one
anywhere but loopback would publish an unauthenticated inference server. They
are still *shown* in the UI, so the effective command line is never a mystery.

### State that a restart must survive

sd-api kept jobs, downloads and settings in memory. That was defensible when
nothing restarted on its own — but the process manager now restarts backends by
itself, and a restart that silently drops a queue or orphans a 39GB partial
download is worse than the problem it solves.

Jobs, downloads and settings are therefore in SQLite (`db/schema.ts`), and both
managers reconcile at startup: a job recorded as running is failed with a
message saying so and left retryable; an in-flight download is marked
resumable rather than left showing a progress bar that never moves.

**The model list is deliberately not in the database.** A model *is* the files
on disk. An operator can drop a bundle onto the volume, a download can be
interrupted, a directory can be deleted underneath the app — and in every one of
those cases the disk is right and a database row would be a lie the UI shows the
user. `ModelManager` scans.

### One bundle layout, one download manager

sd-api had three parallel model trees (`models/`, `llm-models/`,
`audio-models/`) with three `DownloadManager` instances that had already
diverged in their allowed extensions and manifest rules.

One layout now serves all four kinds, because what varies between an image model
and an LLM is which component directories are populated, not how a bundle is
structured:

```
models/<kind>/<bundle>/
  model.json      manifest
  checkpoint/     diffusion model or full checkpoint   (-m | --diffusion-model)
  vae/ clip/ lora/   image and video components
  weights/ aux/   LLM and audio components
  <anything>/     requirement 8's "other (specify)", created on demand
```

A component slot is either a known name or `other:<dirname>`, which is what
makes "add to bundle" one endpoint covering LORA, checkpoint, VAE and the
user-specified case rather than four.

### The catalogue is remote, with no fallback

Requirement 7 replaces sd-api's hardcoded `catalog/data.ts` with a remote
`pepper-catalogue.json`. There is deliberately no curated model list in this
repository — not even a fallback, which would quietly become the real catalogue
the first time the fetch had a bad day. The layers are: live fetch → cached copy
on the volume → an explicit `CATALOGUE_UNAVAILABLE` error.

Per-component *file* listings stay live against HuggingFace, so a new
quantization upload is not a catalogue edit. Three classes of file are filtered
out because each would install as a bundle that looks complete and then
misbehaves: multi-part shards (the downloader fetches one file per component,
so a lone shard is a truncated model), vision projectors outside the
`llm_vision` role, and speculative-decoding draft weights (which load fine and
generate visibly worse output — the worst kind of wrong).

### Logs carry real severities

sd-api forwarded every child-process line at pino's `debug` level, so a CUDA
OOM and a tensor-shape trace arrived indistinguishable — the "current
implementation is not helping" complaint in requirement 5. These backends *do*
emit levels, just not machine-readably, so `logs/parse.ts` recovers the level
from the line's own text (`[INFO ] file.cpp:123 - …`, `error:` openers, and a
set of failure phrases that appear as bare text).

Unrecognised stdout is `info` and unrecognised stderr is `warn` — never `error`.
These tools write ordinary progress chatter to stderr, so treating the stream as
a severity signal would mark every healthy startup as failing.

Filtering happens server-side, including on the live SSE stream: a running
generation emits thousands of lines a minute, and shipping all of them so the
browser can hide most is what makes a log viewer stutter.

## Gotchas worth keeping

These cost real debugging time; the code comments carry the short version.

- **Abort-on-disconnect must watch `reply.raw`, not `req.raw`.** Node's
  `IncomingMessage` fires `close` once the request body is fully read — not when
  the client goes away — so wiring an abort controller to it aborts the upstream
  fetch on *every* request before a byte comes back. The symptom is an empty 200
  with no body on every call.
- **`pino.multistream()` does not inherit the logger's level.** Each stream
  entry defaults to `info` regardless of the parent, so without an explicit
  `level` on each, a debug deployment silently drops every backend line.
- **`forceCloseConnections: true` is required** or `app.close()` hangs waiting
  for idle keep-alive sockets (an OpenAI client's pool against `/v1/llm/*`)
  that Node's `server.close()` never forces.
- **audio.cpp refuses to start with an empty model registry** (`exit 1`), unlike
  llama.cpp which happily serves zero models. The `prepare` hook returns
  `skip: true` when no audio models are installed — a fresh deployment is an
  expected state, not a startup failure.
- **sd-cli's video output only supports `.avi`, `.webm` or animated `.webp`.**
  Passing `.mp4` writes `<path>.avi` and exits 0, so the file check fails with
  nothing at the expected path. `.webm` is the one a browser `<video>` plays.
- **Exit 0 is not proof of output.** sd-cli reports success when it cannot
  encode to the requested container, so the output file is stat'd and
  size-checked before a job is called complete.
- **Prebuilt binaries ship sibling shared libraries with a RUNPATH pointing at
  the build machine.** `loaderEnv()` adds the binary's own directory to the
  loader path, or the process dies at startup on any host but the one it was
  compiled on.
- **Route shapes collide across the modern and legacy APIs.** Fastify cannot
  distinguish `/v1/models/:kind` from sd-api's `/v1/models/:model`, so there is
  no kind-scoped list route — `GET /v1/models?kind=` covers it, and the
  compatibility path keeps the spelling that has no alternative.
- **`@fastify/static` with `wildcard: false` does not serve `/assets/*`**, so
  every JS module request fell through to the SPA fallback and returned
  `index.html` with a `text/html` MIME type. The page renders blank with one
  console error about strict MIME checking.

## Conventions

- A route is a plugin: `export async function xRoutes(fastify)`, registered in
  `server.ts`, with a zod `schema` carrying tags and summaries so `/docs` stays
  useful.
- Services take their dependencies as constructor arguments and are decorated
  onto the app once, so a route's dependencies are visible at the call site.
- Reuse `errors.*`, `safeResolve`/`assertSafeName`, `parseBackendLine`,
  `Semaphore`, and `DownloadManager` for any new downloadable artifact.
- Anything a user can abort, retry or delete belongs in SQLite. Anything that
  describes files on disk is read from the disk.
