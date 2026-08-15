# sd-api compatibility

Requirement 11: *"API contract should be fully compatible with the current
sd-api you can add new endpoints / modify existing while maintaining backward
compatibility."*

Viceroy runs against sd-api's paths and response shapes today, so every one of
them still works and returns what it returned before. The modern, unified
surface exists alongside it. Nothing is implemented twice — `routes/compat.ts`
delegates to the same services and translates shapes at the edges.

## Verification

Every path below was requested against a running server and resolved to a
handler (48 paths; a `NOT_FOUND` route error would have failed the check):

```bash
npm run build && DATA_DIR=./data AUTO_INSTALL_BACKENDS=false npm start
python3 docs/check-compat.py     # prints MISSING: none
```

## What is unchanged

| sd-api path | Notes |
| --- | --- |
| `GET /health` | Adds `uptime` and `version`. |
| `POST /v1/generate` | Same request and response. Now runs through the job queue rather than spawning directly. |
| `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/stream` | `DELETE /v1/jobs/:id` still aborts a running job, and now also removes the record. |
| `GET /v1/models`, `POST /v1/models`, `GET /v1/models/:model`, `DELETE /v1/models/:model`, `PUT /v1/models/:model/manifest`, `DELETE /v1/models/:model/:type/:name`, `POST /v1/models/download` | Image models. Response keeps `checkpoint`/`vae`/`clip`/`loras`/`partials`. |
| `/v1/llm-models/*`, `/v1/audio-models/*` | Same shape per kind, including `POST /v1/audio-models/:model/voice-presets`. |
| `/v1/downloads/*`, `/v1/llm-downloads/*`, `/v1/audio-downloads/*` | List, get, cancel, retry, delete, stream, resume. Task keeps `model` and `type` alongside the new `bundle`/`slot`. |
| `/v1/catalog`, `/v1/llm-catalog`, `/v1/audio-catalog` (+ `/:id/files`) | Now served from the remote catalogue instead of hardcoded data. |
| `/v1/llm/chat/completions`, `/completions`, `/embeddings`, `/models` | Byte-for-byte proxy, streaming intact. |
| `/v1/audio/speech`, `/transcriptions`, `/voices`, `/models`, `/tasks/run` | As before. |
| `GET`/`DELETE /v1/audio-voice-refs/:name` | Also available at `/v1/audio/voice-refs/:name`. |
| `POST /v1/inputs`, `GET /v1/inputs/:name` | Upload now returns `kind` and `url` in addition to `name`. |
| `GET /v1/outputs/:name` | Adds long-lived cache headers, since outputs are immutable. |
| `GET /v1/auth/hf`, `POST /v1/auth/hf/verify` | Unchanged. |
| `GET /v1/logs`, `GET /v1/logs/stream` | Filters gain `source` and `minLevel`; the old query still works. |

## Behavioural differences worth knowing

These are additive or strictly-better, but they are behaviour changes:

- **`POST /v1/generate` is queued.** It still blocks until the result is ready
  and returns the same body, but it now shares `MAX_CONCURRENT_JOBS` with
  `/v1/jobs` instead of spawning immediately. sd-api's synchronous route had no
  admission limit, and three concurrent requests were enough to exhaust memory
  and have the OS kill the server.
- **Jobs and downloads survive a restart.** A client polling a job id across a
  server restart now gets the job back (failed and retryable) instead of a 404.
- **Cancelled downloads keep their partial file**, so `retry` resumes rather
  than restarting a 40GB transfer.
- **`DELETE /v1/jobs/:id` deletes.** In sd-api it only cancelled, leaving the
  record in the list forever.
- **Error codes are preserved.** The generic backend lifecycle errors alias
  back to sd-api's per-backend codes — a llama.cpp startup failure is still
  `LLM_STARTUP_FAILED`, an audio one still `AUDIO_STARTUP_FAILED` — so client
  error handling keeps matching.

## Additions

New endpoints, none of which a legacy client needs to know about:

- `GET /v1/models?kind=` and `/v1/models/:kind/:bundle/...` — the unified model
  surface, including `POST .../components` (add-to-bundle, with
  `other:<dir>` support) and `POST .../resume`.
- `GET /v1/catalogue`, `POST /v1/catalogue/refresh`,
  `GET /v1/catalogue/:id/files`, `POST /v1/catalogue/:id/install`.
- `GET /v1/downloads/stream` and `GET /v1/jobs/stream` — aggregate SSE streams,
  so a UI opens one connection instead of one per resource.
- `POST /v1/jobs/:id/cancel` and `/retry`.
- `GET /v1/outputs` and `GET /v1/inputs` — listings. sd-api could serve a file
  by name but not enumerate, so a client that lost an id lost the file.
- `GET /v1/backends`, `PUT /v1/backends/:backend/args`,
  `POST /v1/backends/:backend/{start,stop,restart,install}` — process and
  argument management.
- `GET /v1/system/status`, `GET /v1/config`.
- `POST`/`GET`/`DELETE /v1/audio/voice-refs`.

## One path that could not be kept

There is no `GET /v1/models/:kind` list route. Fastify cannot distinguish
`/v1/models/:kind` from sd-api's `/v1/models/:model` — they are the same shape
at one path segment — so the compatibility spelling wins and filtering by kind
is `GET /v1/models?kind=image`. Nothing is lost: the query form covers it, and
the sd-api path is the one with no alternative.
