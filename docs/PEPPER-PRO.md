# Pepper Pro

A design proposal for a second product built on Pepper's codebase: production
image, video and audio work, driven through ComfyUI as the only generation
engine and llama.cpp for language, organised around projects rather than a
prompt box.

Status: proposal, September 2026. Nothing here is built. The research this
rests on (models, recipes, quality techniques, hardware, licences) is in
`docs/PRODUCTION-VIDEO.md`; this document covers the product and the code.

---

## 1. Decision summary

| Question | Decision |
| --- | --- |
| Two products or one? | Two. **Pepper** stays the lightweight engine (sd-cli, llama.cpp, audio.cpp, Python runners) for local, Mac and Kaggle use and the sd-api contract. **Pepper Pro** is the production tool for GPU pods. |
| Pro's generation engine | **ComfyUI only**, for image, video and audio. llama.cpp for text and vision-language work. No sd-cli, audio.cpp, vLLM or one-shot Python runners. |
| How much code is shared? | Everything that is not an engine: jobs, downloads, logs, DB plumbing, auth, gallery and media serving, preferences, idle tracking, MCP scaffolding, launchers, and the shared web components. |
| How is it shared? | **One monorepo with a shared core**, not a copy. Two copies of the core drift within weeks, and every fix to jobs, downloads or auth then has to be made twice. |
| What does a Pro user see? | Projects, assets, shots, takes and a cut. Never a node graph. |
| What is the unit of curation? | A **recipe**: a pinned workflow template, the exact model files and LoRAs it needs, defaults tested per hardware tier, and sample outputs. Recipes replace catalogue bundles. |
| What does Pro drop? | The sd-api compatibility layer, Mac and Kaggle as targets, and anything that only exists to drive a CLI. |

---

## 2. Why ComfyUI for everything

- **Video.** Every technique that turns open weights into production output
  exists first, and usually only, as a ComfyUI workflow: the H3 hybrid
  loader, trained latent upscalers, Motion Context chaining, LTX-2.5
  audio-to-video, turbo LoRA stacks, retake stitching, motion transfer
  (`PRODUCTION-VIDEO.md` §3, §5).
- **Images feed video.** Keyframes, try-on edits, multi-reference
  composites, pose ControlNets and character sheets are all inputs to shots.
  With one engine, image → edit → video → upscale can run in one process,
  without loading models twice or passing files between engines. The image
  tooling around the base models (Krea 2 and Qwen-Image LoRAs, ControlNet
  unions, LanPaint inpainting, head swap, the Photoshoot nodes) also lands in
  ComfyUI first.
- **Audio is covered well enough.** ACE-Step 1.5 and MiniMax Music 3 are
  native; YuE2 has nodes; TTS runs through community packs (TTS Audio Suite
  for IndexTTS-2, VibeVoice, Chatterbox and others; Qwen3-TTS nodes). H3
  writes and voices dialogue itself, which reduces how much Pro depends on
  TTS at all.
- **New work arrives as a pin, not a port.** Supporting a new technique means
  pinning a node pack, adding a template and a smoke test. Porting the same
  thing into sd-cli or a runner is days of work, and the community ships
  weekly.

What Pro gives up, and why Pepper keeps existing: sd-cli is small, starts
fast, needs no Python, runs GGUF well in little RAM, and works on a Mac and on
Kaggle. None of that matters on a 32–96 GB pod, and all of it matters on a
laptop.

---

## 3. Repository layout

```
pepper/                              (the existing repo, renamed nothing)
  packages/
    core/        server core: jobs, downloads, logs, db plumbing, auth, media
                 serving, settings, activity/idle, MCP scaffolding, util
    ui/          shared React: gallery, jobs, logs, downloads, preferences,
                 media player, app shell, API client base
  apps/
    pepper/      server + web: sd-cli, llama.cpp, audio.cpp, vLLM, runners,
                 the lite catalogue, sd-api compat, current screens
    pepper-pro/  server + web: ComfyUI engine, llama.cpp, recipes, projects,
                 storyboard, cut, Pro MCP tools
  deploy/        launchers with a --product pepper|pro profile
  docs/
```

Two images are built from this repo (`ghcr.io/searpro/pepper` and
`ghcr.io/searpro/pepper-pro`), each with its own catalogue, data volume and
launcher profile.

Separate repositories only make sense once `core` has stopped changing weekly.
At that point `core` and `ui` can be published as packages and Pro can move
out. Doing it earlier puts a release step between every core fix and the
product that needed it.

### 3.1 What goes where

Sizes are today's line counts in `server/src`, to show the shape of the split.

| Today | Lines | Goes to |
| --- | --- | --- |
| `jobs/`, `downloads/`, `logs/`, `db/` (client, migrations, quarantine) | ~2,000 | `core` |
| `auth.ts`, `errors.ts`, `paths.ts`, `util/` | ~1,600 | `core` |
| `backends/manager.ts`, `process.ts`, `monitor.ts` (process supervision) | ~1,400 | `core` |
| `backends/args.ts`, `installer.ts`, `release.ts`, `vllm.ts`, `python*.ts` | ~1,650 | `apps/pepper` |
| `services/activity.ts`, `resources.ts`, `storage.ts`, `proxy.ts` | ~500 | `core` |
| `services/image*.ts`, `audio-*.ts`, `s2v.ts`, `python-video.ts`, `upscale*.ts` | ~2,800 | `apps/pepper` |
| `services/characters.ts`, `text-gen.ts` | ~700 | `core` (characters become a project asset type in Pro) |
| `models/bundle.ts`, `catalogue/` | ~1,700 | split: manifest fetch and validation in `core`, bundle slots in `apps/pepper` |
| `mcp/` | ~1,400 | `core` (server, media view, `get_job`); each app registers its own tools |
| `routes/` | ~3,600 | split by area; engine routes stay in each app |
| `python/pepper_runner` | ~1,300 | `apps/pepper` |

About half of the server moves to `core` unchanged. The web side splits the
same way: gallery, jobs, logs, downloads and preferences go to `ui`; the
Generate, Image, Audio and Text screens stay in Pepper.

---

## 4. The engine seam

`JobManager` already dispatches by kind (`registerExecutor(kind, executor)`),
and executors receive `{ job, signal, onProgress, onLog }`. That is the seam.
An engine is a set of executors plus the lifecycle of whatever process runs
them:

```ts
/** A generation engine: one supervised process and the job kinds it serves. */
export interface Engine {
  readonly id: string;                       // 'sdcpp' | 'comfy' | 'llamacpp' | ...
  /** Job kinds this engine executes, registered with JobManager at startup. */
  executors(): Partial<Record<JobKind, JobExecutor>>;
  /** Install or verify binaries and environments; runs after listen(). */
  prepare(): Promise<void>;
  /** Release GPU and host memory so another engine can run. */
  release(reason: 'swap' | 'idle' | 'pressure'): Promise<void>;
  status(): EngineStatus;                    // for /v1/system/status and the header
}
```

`core` owns job persistence, progress fan-out, cancellation and outputs.
Engines own how a spec becomes a file. Memory arbitration between engines
(stop llama.cpp before a Comfy job, and the reverse) moves from
`PythonVideoService`'s ad-hoc "stop the resident backends" into `core`, since
both products need it.

Pepper refactors onto this interface first (§10, step 1), which proves the
seam with the engines it already has before Pro adds a new one.

---

## 5. The ComfyUI engine

### 5.1 Process

- ComfyUI is a managed process under `core`'s supervision, like
  llama-server: health-checked on `/system_stats`, restarted on crash, stopped
  when idle.
- It listens on **127.0.0.1 only**. Its API has no authentication, so it is
  reachable solely through Pro's own routes, behind `PEPPER_API_TOKEN`.
- Launched with `--whitelist-custom-nodes` (only the packs the image pins)
  and with Hugging Face in offline mode. Weights come from the catalogue,
  never from a node's own downloader.
- The Python environment, ComfyUI itself and every custom node pack are
  pinned to commit hashes and built into the image, following the rule
  Pepper already follows for its runners: an install on a network volume at
  run time takes 20+ minutes, so a new dependency is an image change.
- ComfyUI-Manager is not installed. Nothing installs at run time.

### 5.2 Running a job

1. Take the recipe's API-format workflow template and apply the job's
   parameters through the recipe's bindings (§6).
2. Upload inputs (reference images, audio, first/last frames) with
   `/upload/image`, or reference them by path under the shared input
   directory.
3. `POST /prompt` with a client id; record the prompt id on the job.
4. Follow the websocket: `executing` names the running node, and `progress`
   gives step counts within it. Map both onto `StepProgress`, weighting each
   node by the share of the run it usually takes (recorded per recipe), so a
   job's bar moves evenly rather than jumping between nodes.
5. On `execution_success`, read `/history/<prompt_id>`, copy the outputs into
   Pro's outputs directory, then stat and size-check them. ("Exit 0 is not
   proof of output" applies to ComfyUI too.)
6. On `execution_error`, turn the node type, the exception type and the last
   traceback line into an `errors.*` code. Known failures (out of memory, a
   missing model file, a bad input size) get their own codes and messages;
   everything else becomes `ENGINE_FAILED`, with the traceback in the job log.

Cancel is `POST /interrupt`, which is global. Pro therefore runs **one
ComfyUI job at a time**, so an interrupt can only ever hit the job it was
meant for. On a single GPU that costs nothing: two video jobs would not fit
side by side anyway.

### 5.3 Memory

ComfyUI keeps models cached between runs; Pepper's runners load and exit.
Pro needs both behaviours:

- **Same recipe family, next take:** keep the models loaded. On a 96 GB card,
  auditioning eight H3 seeds without reloading 45 GB each time is the point.
- **Switching family** (an image recipe after a video recipe): call `/free`
  with `unload_models` and `free_memory` first.
- **Recycling:** restart ComfyUI after a configurable number of jobs, or when
  host RAM crosses a threshold. Long sessions fragment memory, and a restart
  costs seconds while an OOM kill loses a job. This is the same principle as
  "backends are recycled on swap" in `ARCHITECTURE.md`.
- **Arbitration with llama.cpp:** stop one before the other runs on a 24–32 GB
  card. On a 96 GB card both can stay resident. Make that a setting with a
  per-tier default.

### 5.4 Environment conflicts

ComfyUI runs every node pack in one Python environment, so two packs pinning
incompatible versions of a shared library break each other. The rules:

- A pack is only added after its dependencies resolve against the pinned
  environment, checked when the image is built.
- A pack that cannot coexist runs in a **second ComfyUI instance** with its
  own venv (the likely cases are TTS packs and YuE2). The engine routes
  recipes to an instance by name. This mirrors Pepper's isolated venvs
  (`ensureIsolatedEnvironment`).
- Every recipe has a smoke test that runs in CI when the image is built:
  load the template, bind the parameters, validate the graph against
  `/object_info`, and on a GPU runner render a tiny output.

### 5.5 Licence

ComfyUI is GPL-3.0. Pro drives it as a separate process over HTTP and never
imports its code, so Pro's own code keeps its licence. The published image
must offer the source for ComfyUI and any GPL node packs it contains. Custom
node licences vary, so a pack's licence is checked when it is pinned.

---

## 6. Recipes

A recipe is what a user installs, and what the curator maintains. It
replaces Pepper's catalogue bundle for Pro.

```jsonc
{
  "id": "h3-ref2va-hybrid",
  "version": 3,
  "kind": "video",
  "name": "MiniMax H3 reference video (hybrid)",
  "capabilities": ["ref-images", "voice-ref", "dialogue", "draft", "finish"],
  "licence": { "id": "minimax-h3-community", "commercial": "under-20M",
               "excludedTerritories": ["US", "EU", "UK", "KR"],
               "uiNotice": "Powered by MiniMax H3" },
  "instance": "main",
  "nodes": [{ "repo": "scottmudge/ComfyUI_MinimaxH3HybridLoader", "commit": "…" }],
  "files": [
    { "folder": "diffusion_models", "repo": "…", "file": "…", "sha256": "…", "bytes": 0 },
    { "folder": "text_encoders",    "repo": "…", "file": "…" },
    { "folder": "vae",              "repo": "…", "file": "…" },
    { "folder": "loras",            "repo": "…", "file": "…", "optional": "turbo" }
  ],
  "tiers": {
    "24gb-64ram": { "files": { "diffusion_models": "int8" }, "defaults": { "width": 1344, "height": 768 } },
    "96gb":       { "files": { "diffusion_models": "bf16" } }
  },
  "modes": {
    "draft":  { "workflow": "h3-ref2va-draft.json",  "defaults": { "steps": 8, "lora": "turbo", "megapixels": 0.4 } },
    "finish": { "workflow": "h3-ref2va-finish.json", "defaults": { "steps": 20, "latentUpscale": 2 } }
  },
  "bindings": {
    "prompt":    { "node": "12", "input": "text" },
    "seed":      { "node": "31", "input": "noise_seed" },
    "refImages": { "node": "7",  "input": "images", "list": true, "max": 9 },
    "voiceRefs": { "node": "8",  "input": "audio",  "list": true, "max": 3 }
  },
  "samples": ["…/sample-dialogue.mp4"],
  "verified": { "date": "2026-10-02", "gpu": "RTX 5090", "secondsPerTake": 150 }
}
```

- **Templates live in the repo** (`apps/pepper-pro/recipes/<id>/*.json`,
  exported in ComfyUI's API format). The catalogue entry points at them by
  name. Graph structure is code: it changes through review, and it has
  tests.
- **Bindings are the only way parameters reach a graph.** They are the
  successor to "CLI arguments are data": a table, not string building. A
  binding that no longer matches a node's inputs fails the smoke test, not
  a user's job.
- **Tiers pick files and defaults per hardware class**, so an install never
  lands a Q4 file on a host that could run INT8, or an INT8 file on a host
  whose RAM cannot hold it.
- **`verified`** records when and where a recipe last passed its golden shots
  (§9.4). Anything not verified in 60 days is flagged in the UI.
- **Licence data is structured**, so Pro can filter recipes by the project's
  licence mode and show the required notices at export.

Upkeep is the real ongoing cost. With 10–20 recipes and a community that
ships weekly, expect a few hours a week. The `catalogue-curator` skill grows
into a recipe curator: research a change, update the template and pins, run
the smoke test and golden shots on a pod, open a PR on the Pro catalogue.

### 6.1 The starting set

| Recipe | Replaces in Pepper | Notes |
| --- | --- | --- |
| Krea 2 + hires detail pass | Z-Image, Qwen-Image T2I | Photoreal default; under-$1M licence. Z-Image variant for Apache-only projects |
| Multi-reference edit (Qwen-Image 2.1 / FLUX.2 klein 4B) | Qwen edit, Mage-Flow Edit | Qwen for personal mode (research licence), klein 4B for commercial |
| H3 FL2VA (T2V, first, last, first+last) | `minimax-h3-fl2va` | Draft and finish modes |
| H3 Ref2VA hybrid | `minimax-h3-ref2va` | The Ref2VA fix, dialogue, voice references |
| LTX-2.5 A2V (image + audio, first frame + audio) | nothing (sd-cli lacks A2V) | Frozen audio latent |
| Long take (H3 Motion Context chain) | `s2v.ts` chunking | Engine-side chaining with latent carry |
| SeedVR2 / VOSR 2.0 finish | Upscale screen | Video and image |
| ACE-Step 1.5 / MiniMax Music 3 | audio.cpp music | |
| TTS (Qwen3-TTS, IndexTTS-2) | audio.cpp / Chatterbox | Possibly a second instance (§5.4) |

Specialists come after (§10): LongCat-Avatar 1.5, InfiniteTalk, Wan-Dancer,
Wan-Animate-2 / SCAIL-2, try-on.

---

## 7. Models on disk

- Pro uses **ComfyUI's own folder layout** (`models/diffusion_models`,
  `text_encoders`, `vae`, `loras`, `upscale_models`, `audio_encoders`, …)
  under its data volume, rather than Pepper's per-bundle slot directories.
  A file shared by several recipes, such as H3's 32B encoder, is stored
  once.
- `core`'s download manager (resume, quota check, stall handling) downloads
  into those folders unchanged. A recipe install is a list of file
  downloads, followed by a check that every file exists with the expected
  size and hash.
- Deleting a recipe removes only the files no other installed recipe
  references. That is a reference count computed from disk plus the
  installed-recipe table, so it follows the rule "anything describing files
  on disk is read from disk".
- llama.cpp models keep their current layout under `llm/`.

---

## 8. Projects

This is Pro's reason to exist. The domain model from `PRODUCTION-VIDEO.md`
§6, as tables:

```
projects      id, name, aspect, fps, style_lut, licence_mode, created_at
assets        id, project_id?, kind (character|location|prop|product|voice|audio),
              name, description, images[], identity (refmod|lora|refs), voice{}, meta{}
              -- project_id null: a library asset reused across projects
scenes        id, project_id, position, title, notes
shots         id, scene_id, position, kind, duration_s, framing, camera,
              prompt, dialogue[{asset_id, line}], asset_ids[], keyframes{first,last},
              audio{driving_asset_id? | generated}, recipe_id, params{}
takes         id, shot_id, job_id, mode (draft|finish), seed, chosen, score?, notes
cuts          id, project_id, items[{take_id, in, out, transition}],
              music_asset_id?, subtitles, export_job_id?
```

- Characters as they exist today (`characters` table) become `assets` with
  kind `character`, and today's service moves to `core`. Pepper keeps its
  Character Studio on top of the same table.
- A take is a job. Its status, progress, logs and output come from `core`'s
  job system, so the Jobs screen, the gallery and `get_job` work unchanged.
- The cut renders with ffmpeg (`util/ffmpeg.ts`): trims, crossfades, the
  music bed, EBU R128 loudness, the project LUT, burned-in or sidecar
  subtitles, and the 9:16 and 16:9 exports. That is a `render` job kind run
  by an ffmpeg engine that both products share.
- Beat detection and stem separation are small Python tasks (librosa,
  Demucs) exposed as `analyze` jobs, so music projects can cut on the beat
  and lip-sync to isolated vocals.

### 8.1 Screens

Shared from `ui`: Gallery, Jobs, Logs, Downloads, Preferences. Pro-only:

1. **Projects:** a list, plus "new from script".
2. **Project:** the script, style, licence mode and asset library.
3. **Storyboard:** a grid of shot cards (keyframe, dialogue, assets, recipe),
   with "draft ×4" per card or for a whole scene.
4. **Shot:** takes side by side, pick one, "finish", retake a time range.
5. **Cut:** a timeline of chosen takes, the music bed, beat markers,
   subtitles, and export.
6. **Recipes:** install and remove, tier fit, licence, samples, and the date
   each was last verified.

### 8.2 MCP

Pro keeps `core`'s MCP scaffolding: a stateless endpoint, the 50 s limit, the
media view and `get_job`. It adds three tools and none of Pepper's
per-medium ones:

| Tool | Does |
| --- | --- |
| `plan_project` | Create or edit a project from a script or brief: assets, scenes, shots, and a recipe per shot. Returns the shot list |
| `render_shots` | Shot ids plus `draft` or `finish` (and optional seeds) → job ids |
| `get_project` | Shots, takes and their states, the chosen takes, and the cut |

Claude becomes the director: it breaks a script into shots, writes prompts in
each recipe's format (H3's `<Subject n>` bindings, quoted dialogue, the
`Sound:` clause), reviews drafts in the media view, and asks for retakes.
Keeping to three tools follows the existing rule that tool descriptions sit
in every conversation.

### 8.3 llama.cpp's role

On the pod, not only in Claude:

- a local prompt writer and rewriter for users who drive Pro from the web app
  alone (a vision-language model that reads the reference images);
- captions for identity packs and LoRA datasets;
- automatic checks on takes: a VLM flags a missing subject, a wrong garment
  colour, or a garbled label before a human looks.

---

## 9. Operations

### 9.1 Hardware tiers

| Tier | Example | Use |
| --- | --- | --- |
| `24gb-64ram` | 4090 on a 64 GB+ RAM host | Images, LTX-2.5, H3 INT8 drafts |
| `32gb` | 5090 | The default video tier |
| `48gb` | L40S / A6000 | LongCat-Avatar 1.5, H3 with its encoder resident |
| `96gb` | RTX PRO 6000 | Finishing sessions, everything resident |

The launcher's Pro profile picks a tier (`--tier`), requests the matching
GPU and minimum RAM, and tells the server its tier, so the recipes screen
only offers what fits.

### 9.2 Image and cold start

The Pro image carries torch, ComfyUI and its node packs: expect 15–25 GB,
against Pepper's much smaller one. Cold start on a new pod is therefore
image pull plus model load. Mitigations: keep the image on RunPod's cache
by using one tag per release rather than per commit, keep models on the
network volume, and warm the active project's recipe family at startup.

### 9.3 Idle shutdown

Unchanged. `core`'s activity rules apply. A running ComfyUI job is work in
progress, and ComfyUI's own polling does not count as activity.

### 9.4 Golden shots

A fixed set of about 20 shots across the four targets (two-person dialogue,
singing close-up, product orbit, lookbook turn, wide action). Every recipe
change renders them with fixed seeds, stores the results next to the previous
version, and offers a blind A/B in the Recipes screen. A recipe version ships
when it wins or ties. This is how "better" becomes a record instead of an
impression.

---

## 10. Plan

Each step leaves both products working.

| Step | Work | Done when | Estimate |
| --- | --- | --- | --- |
| 1. Seam | Introduce `Engine`; move Pepper's sd-cli, llama.cpp, audio.cpp, vLLM and runners onto it; move memory arbitration into `core` | Pepper's tests and typecheck pass; no behaviour change | 1 week |
| 2. Split | Workspaces `packages/core`, `packages/ui`, `apps/pepper`; move files per §3.1; Pepper builds and deploys from `apps/pepper` | Same image and behaviour, new layout | 1 week |
| 3. Engine | `apps/pepper-pro` skeleton on `core`; ComfyUI engine (§5); recipe loader and bindings (§6); Comfy-layout downloads (§7); Pro image and launcher profile | One recipe (Krea 2) renders end to end on a pod through a job | 1–2 weeks |
| 4. Recipes | The starting set (§6.1), smoke tests in CI, first golden shots | Every starting recipe passes on its tier | 2 weeks |
| 5. Projects | Tables, screens and cut render (§8), the MCP trio | A short script becomes an exported 9:16 video with dialogue, from the web app and from Claude | 3–4 weeks |
| 6. Specialists | LongCat-Avatar, InfiniteTalk, Wan-Dancer, motion transfer, try-on; beat cutting; VLM take checks | Each target in `PRODUCTION-VIDEO.md` §4 has a recipe and a golden shot | ongoing |

Steps 1 and 2 are worth doing even if Pro were never built: they untangle
Pepper's engines from its platform code.

---

## 11. Risks

| Risk | Likelihood | Effect | Mitigation |
| --- | --- | --- | --- |
| A node pack update breaks a template | High | A recipe fails | Commit pins, bindings validated against `/object_info`, CI smoke tests |
| Dependency conflict between packs | High | A pack cannot be added | Resolve at image build; second instance with its own venv |
| Memory growth over long sessions | Medium | OOM kills a job | `/free` on family switch; recycle after N jobs or at a RAM threshold |
| Recipe upkeep outpaces one person | Medium | Stale recipes | Keep the set small; curator skill with pod-side tests; "verified" dates |
| Malicious or compromised node pack | Low | Code execution on the pod | Whitelist, commit pins, review on every bump, localhost-only ComfyUI, no runtime installs |
| Licence mismatch in client work | Medium | Legal exposure | Structured licence data, per-project licence mode, notices at export |
| Core refactor destabilises Pepper | Medium | Regressions in the lite product | Steps 1–2 change no behaviour and must pass the existing test suite |
| Upstream ComfyUI API changes | Low | Adapter breaks | Pin ComfyUI; the adapter uses only `/prompt`, `/history`, `/upload`, `/interrupt`, `/free`, `/object_info` and the websocket |

---

## 12. Open questions

- **Name and branding.** "Pepper Pro" is a working name.
- **One SPA or two?** Two app shells over `ui` keeps each product small; one
  SPA with a product flag is less build work. Two shells is the default.
- **Does Pepper keep its screens for video?** Once Pro exists, Pepper could
  drop H3 and LTX-2.5 (they are the reason its pods need 46 GB of RAM) and
  stay truly lightweight: images, speech, music, and Wan 2.2 5B-class video.
- **Commercial H3 use.** If client work outside the excluded territories is
  planned, decide early whether to buy a commercial licence (Comfy resells
  them) or keep H3 recipes to personal projects.
- **A second ComfyUI instance by default?** Only if TTS packs conflict with
  the video packs in practice. Test before building it.

---

## 13. Status

What exists now, where it departs from the plan above, and what has not been
proven.

### 13.1 Built

| Step | What is in the repository |
| --- | --- |
| 1. Seam | `Engine` and `EngineRegistry` in `packages/core/src/engines`; Pepper's sd-cli, llama.cpp, audio.cpp, vLLM and Python runners behind it (`apps/pepper/server/src/engines/pepper.ts`), memory arbitration in core |
| 2. Split | `packages/core`, `packages/ui`, `apps/pepper`; Pepper's image, Kaggle kernel and RunPod entrypoint build and run from the new layout; its 129 tests pass |
| 3. Engine | `apps/pepper-pro`: the ComfyUI process (pinned v0.38.0, custom nodes off except what recipes whitelist, no API nodes), one prompt at a time over HTTP and the websocket, cancel by dequeue + interrupt, `/free` on a family switch, recycling after N jobs, OOM mapped to a clear error; recipes, bindings and validation; ComfyUI-layout downloads; `Dockerfile.pro` (validates every recipe against the ComfyUI it installs before the image can publish); `launch.py up --product pro --tier …` |
| 4. Recipes | 19 recipes (below); `validate-recipes` against a live ComfyUI, and offline in the unit tests against a saved subset of its node types; a `test` workflow in CI |
| 5. Projects | Tables, routes and screens for projects, cast, scenes, shots, takes and cuts; the cut render (trims, crossfades, ducked music bed, LUT, burned-in or sidecar subtitles, two-pass −14 LUFS); the MCP tools |
| 6. Specialists | InfiniteTalk (one and two speakers), LongCat-Avatar, Wan-Animate 2, Wan-Dancer, SCAIL-2 character replacement, Qwen3-TTS (cloned, designed, preset and multi-voice speech), two-image try-on; `analyze` jobs (beats, stems, Whisper transcription against the line, a vision model's check of a take); cuts that land on the beat; golden shots with a blind A/B per recipe version, speech results checked by ear automatically |
| Long takes | A shot longer than its recipe renders at once becomes chained segments that continue each other through H3's `previous` input, joined with the overlap cut out; any finished take can be retaken from a second on (`src/projects/chain.ts`) |

Recipes: `h3-video`, `h3-reference`, `ltx25-video`, `ltx23-audio-to-video`,
`infinitetalk`, `infinitetalk-duo`, `longcat-avatar`, `wan-animate2`,
`wan-dancer`, `scail2-replace`, `seedvr2-upscale-video`, `krea2-image`,
`zimage-turbo`, `qwen-image-edit`, `flux2-klein-edit`,
`seedvr2-upscale-image`, `ace-step-music`, `minimax-music-3`, `qwen3-tts`.

### 13.2 Different from the plan, and why

- **Characters stayed in Pepper.** Its Character Studio and table are
  unchanged; Pro's cast is its own `assets` table. Moving characters into core
  would have tied Pro's asset model to a Pepper screen for no gain to either.
- **Recipes ship in the repository and the image**, not in a remote Pro
  catalogue: a recipe pins node packs, and a node pack is an image change
  anyway. A recipe change is a pull request here.
- **The recipe format grew where real templates needed it.** Files carry
  per-tier *variants* (not a tier → file map); bindings live per workflow;
  a list parameter fills slot nodes and empty slots are pruned; `bypass`
  passes a guide node's input through when what it needs is absent; `map`
  turns an enum option into the graph's value. Modes are `draft` and `final`.
  `recipes/README.md` is the reference.
- **H3 references use the native Ref2VA model**, not the hybrid loader, which
  holds the FL2VA and Ref2VA weights at once; worth measuring on a 48 GB tier
  before adopting.
- **More MCP tools than three**: `pro_status`, `list_recipes`,
  `install_recipe`, `generate` and `analyze` beside the trio, because Claude
  needs to see what is installed, make keyframes outside a project and check
  takes. Each is short, and none waits past 50 s.
- **Pepper Pro is RunPod-only.** Kaggle's 16 GB is below every Pro tier.

### 13.3 Not yet proven or not yet built

- **Six of 19 recipes have run on a GPU** (2026-10-01, an RTX PRO 4500
  Blackwell, 32 GB, with 62 GB RAM; the 24 GB tier's cards were not
  available): `h3-video` (10 golden shots in draft, about 7.6 min per 5 s),
  `zimage-turbo`, `qwen3-tts`, `infinitetalk`, `infinitetalk-duo` and
  `flux2-klein-edit`, each with a `verified` entry. H3's continuation holds on
  real footage: a 20 s long take joined two segments with no visible seam,
  the continuing segment repeating exactly the 22 frames that are trimmed, and
  a retake from 10 s kept the opening. The other 13 are validated against
  ComfyUI's node types (ours and ComfyUI's own `/prompt` check) but not yet
  rendered. Findings: H3 drafts are slow on this card (29 min per 15 s
  segment); switching between H3 and another model on 62 GB of host RAM
  thrashes (a Z-Image still took minutes instead of seconds); InfiniteTalk's
  draft is 3.24 s, shorter than most lines.
- **The Pro image is built by CI** on `main`. It was also built locally
  with CPU torch (`--build-arg
  TORCH_INDEX=https://download.pytorch.org/whl/cpu`), which runs the same
  install and recipe smoke test (19 recipes valid inside the image), and
  the container booted and served the app; the CUDA wheels themselves were
  not pulled. That build is what found the missing compiler for LongCat's
  requirements.
- **"New from script" needs a local text model** (`PLAN_MODEL`, else
  `CHECK_MODEL`); without one the project is created with its script and
  planned by Claude through `plan_project` instead. Its prompt is tested
  against a stub, not a real model.
- Long takes carry the shot's first frame, dialogue and driving audio in
  their first segment only; a long talking shot belongs to LongCat-Avatar or
  InfiniteTalk, which run to the audio's length themselves.
- Outside the plan and not built: FastH3, H3 multi-keyframe guides, and a
  second ComfyUI instance (the TTS pack turned out to coexist with the rest,
  so none is needed yet).
