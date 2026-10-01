---
name: catalogue-curator
description: Research new open models, fine-tunes, quantizations and LoRAs for Pepper (image, video, speech, music, LLM), check whether Pepper's backends can run them on a 24 GB GPU, write pepper-catalogue.json entries, test-install them on a running Pepper via MCP, and open a PR on searpro/pepper-catalogue. Use when asked to find, evaluate, add or retire catalogue models.
---

# Catalogue curator

Every Pepper instance fetches `pepper-catalogue.json` from the `main` branch of
**searpro/pepper-catalogue**, so a bad entry breaks installs everywhere within
minutes. **Never push to `main`. Every change is a PR the user merges.**

The schema, the backend rules and the file filters are in `docs/CATALOGUE.md`
in this repo. Read it before writing an entry.

The goal is quality per dollar on a **24 GB RunPod pod**: the best output the
hardware can produce, not the smallest file that loads.

## 1. Research

Start with what is already known: the memory notes on video-model research and
the RunPod quality refresh record what was tested, what failed and why. Then
look for new backend support, then for new models. A model is only useful if a
backend can run it. Sources, in order of signal:

- **Backend releases**: what Pepper installs is the latest release of the
  repos in `apps/pepper/server/src/config.ts` (`DEFAULT_RELEASE_REPOS`). Read their
  release notes and merged PRs for newly supported architectures:
  stable-diffusion.cpp (image/video), llama.cpp (LLMs), audio.cpp (speech, and
  music through its `gen` task). Python runners are fixed:
  `apps/pepper/server/python/pepper_runner/runners`; a model needing a new one is a Pepper
  change first (`pepper-dev` skill), not a catalogue entry.
- **HuggingFace**: new or trending repos by pipeline tag, especially GGUF
  conversions (`?search=gguf&sort=trending`), and fine-tunes, merges and
  LoRAs of models already in the catalogue. Read file lists through the HF
  API; don't clone model or backend repos to look at them.
- **Community**: r/StableDiffusion and r/LocalLLaMA, to see what people rate
  highly in practice.

Skip anything already listed (`catalogue_search`, or the JSON itself). When a
new entry supersedes an old one, propose removing the old one in the same PR:
the catalogue is a short list of the best option per job, not an archive.

## 2. Fit check

Reject a candidate, or note why, unless every one of these holds:

| Check | How |
| --- | --- |
| Architecture supported by the backend release Pepper installs | Release notes / source of that backend version |
| A **single-file** weight exists (no `-00001-of-0000N` shards) | HF file list; the server filters shards out |
| Fits **24 GB VRAM** at the quantization you will recommend | Largest single component, plus working memory |
| The whole set fits **system RAM**: under ~40 GB of weights | Sum of diffusion model(s) + text encoder + VAE. With `--offload-to-cpu` everything is resident in RAM, and a 24 GB pod has 31–46 GB. This, not VRAM, is what aborts loads. |
| Repo is not gated, or a mirror exists | `validate.mjs --live` warns; gated downloads 401 without `HF_TOKEN` |
| Licence allows the use; say so when it is non-commercial or region-restricted | Model card |
| Adds something: quality, speed, a capability, a style | Compare with similar catalogue entries |

Known traps: runtime LoRAs abort sd-cli on Wan 2.2's two-expert models, so
distillation has to come as a merged GGUF; distillation LoRAs plus the hires
pass overcook images.

Present the shortlist to the user with the reasons before writing entries if
there are more than about three candidates.

## 3. Write the entry

1. Clone or update the catalogue repo next to this one:
   `gh repo clone searpro/pepper-catalogue ../pepper-catalogue` (or `git pull`),
   then create a branch named `add-<id>`.
2. Add the entry following `docs/CATALOGUE.md`, copying the closest existing
   entry of the same kind and backend. `defaults` / `extraArgs` / `loadMode`
   matter: without them a downloaded bundle cannot generate. Bump `updatedAt`.
   Beyond the basics:
   - `recommended` on each quantizable component: the file a 24 GB pod should
     run (usually bf16/fp16 weights with a Q8_0 text encoder). Installs
     default to it instead of the smallest file.
   - `alternatives` to offer full-precision safetensors next to GGUF
     quantizations from another repo in one picker.
   - `defaults.hires` for image models that benefit from the second pass, and
     `--offload-to-cpu` in `extraArgs` when the recommended set needs it.
   - `defaults.scheduler` / `sigmas` / `high_noise` and `loraPresets` for
     distilled models and LoRAs with a trained schedule.
   - Music: `kind: "audio"`, `task: "gen"`, a `family` audio.cpp knows — or
     `backend: "python"` with a `pythonRunner`.
3. `node validate.mjs` then `node validate.mjs --live` (resolves every source
   against HuggingFace). Both must pass; read the warnings too.
4. Commit and push the branch. Don't open the PR yet.

## 4. Test on a GPU

Ask the user first: a pod costs money and downloads gigabytes onto a volume
billed by size. See the `pepper-dev` skill for launch details.

1. Check whether an instance is already up (`pepper_status`). If not:
   `uv run deploy/runpod/launch.py up --catalogue-branch add-<id>`
   (a running instance can be pointed at nothing else; a new branch needs a
   new pod). Kaggle (`deploy/kaggle/launch.py --catalogue-branch`) only suits
   entries that fit 16 GB.
2. Through the `pepper` MCP tools:
   - `catalogue_refresh`, then `catalogue_files` → confirm the recommended
     file is the one flagged, and its size.
   - `pepper_status` → `storage` (used / total). The 100 GB volume does not
     hold everything (set sizes are in `deploy/runpod/README.md`). An install
     that will not fit is refused with the numbers; `delete_model` something
     first.
   - `catalogue_install` (no `quant`: it takes the recommended file) → poll
     `list_downloads` until complete. A download stuck at a crawl is a
     HuggingFace stall: there is no MCP tool to cancel one, so ask the user to
     cancel and retry it in the web app (Models → Downloads); it resumes.
   - `pepper_status` → the model shows `ready: true`.
   - Generate 2–3 standard prompts for the kind with a fixed `seed`, so
     results compare across quantizations and settings — image: a portrait, a
     landscape, text rendering; video: one 5 s clip at the default size;
     music: one ~60 s song with lyrics; LLM: a reasoning question and an
     instruction; TTS: two sentences. Note time per output, and any warnings
     in `get_logs`.
   - Look at the outputs before calling them good: download them to the
     scratchpad and view them; compare against the entry they replace.
3. `uv run deploy/runpod/launch.py down` when finished, unless the user wants
   the pod kept.

## 5. Open the PR

`gh pr create` on searpro/pepper-catalogue with: what the model is and why it
earns a place (and what it replaces), the fit-check table, the files tested
and the GPU, timings, anything not verified on a GPU stated as such, and the
sources. If it should join a Kaggle model pack, propose the change to
`deploy/kaggle/packs/*.json` in a separate Pepper PR (packs are capped at
~19 GB). Update the memory note with the measured results.
