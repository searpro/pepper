---
name: catalogue-curator
description: Research new open models, fine-tunes, quantizations and LoRAs for Pepper, check whether Pepper's backends can run them, write pepper-catalogue.json entries, test-install them on a Kaggle Pepper via MCP, and open a PR on searpro/pepper-catalogue. Use when asked to find, evaluate or add models to the catalogue.
---

# Catalogue curator

Every Pepper instance fetches `pepper-catalogue.json` from the `main` branch of
**searpro/pepper-catalogue**, so a bad entry breaks installs everywhere within
minutes. **Never push to `main`. Every addition is a PR the user merges.**

The schema, the backend rules and the file filters are in `docs/CATALOGUE.md`
in this repo. Read it before writing an entry.

## 1. Research

Look first for new backend support, then for new models. A model is only
useful if a backend can run it. Sources, in order of signal:

- **Backend releases**: what Pepper installs is the latest release of the
  repos in `server/src/config.ts` (`DEFAULT_RELEASE_REPOS`). Read their
  release notes and merged PRs for newly supported architectures:
  stable-diffusion.cpp (image/video), llama.cpp (LLMs), audio.cpp (speech).
  Python runners are fixed: `server/python/pepper_runner/runners`.
- **HuggingFace**: new or trending repos by pipeline tag, especially GGUF
  conversions (`?search=gguf&sort=trending`), and fine-tunes, merges and
  LoRAs of models already in the catalogue.
- **Community**: r/StableDiffusion and r/LocalLLaMA, to see what people rate
  highly in practice.

Skip anything already listed (`catalogue_search`, or the JSON itself).

## 2. Fit check

Reject a candidate, or note why, unless every one of these holds:

| Check | How |
| --- | --- |
| Architecture supported by the backend release Pepper installs | Release notes / source of that backend version |
| A **single-file** weight exists (no `-00001-of-0000N` shards) | HF file list; the server filters shards out |
| Fits 16 GB VRAM (Kaggle T4/P100) at some offered quantization | File size plus text encoder/VAE; say which quant |
| Licence allows the use; note gated repos (need HF token) | Model card |
| Adds something: quality, speed, a capability, a style | Compare with similar catalogue entries |

Present the shortlist to the user with the reasons before writing entries if
there are more than about three candidates.

## 3. Write the entry

1. Clone or update the catalogue repo next to this one:
   `gh repo clone searpro/pepper-catalogue ../pepper-catalogue` (or `git pull`),
   then create a branch named `add-<id>`.
2. Add the entry following `docs/CATALOGUE.md`, copying the closest existing
   entry of the same kind and backend. `defaults` / `extraArgs` / `loadMode`
   matter: without them a downloaded bundle cannot generate. Bump `updatedAt`.
3. `node validate.mjs` then `node validate.mjs --live` (resolves every source
   against HuggingFace). Both must pass.
4. Commit and push the branch. Don't open the PR yet.

## 4. Test on Kaggle

Ask the user first: this uses GPU quota and downloads gigabytes.

1. Launch with the branch as the catalogue (see the `pepper-dev` skill for
   the launch details):
   `uv run deploy/kaggle/launch.py --hours 2 --catalogue-branch add-<id>`
2. Through the `pepper` MCP tools:
   - `catalogue_files` → pick the quantization that fits (`quant`).
   - `catalogue_install` → then poll `list_downloads` until complete.
   - `pepper_status` → the model shows `ready: true`.
   - Generate 2–3 standard prompts for the kind (image: a portrait, a
     landscape, text rendering; LLM: a reasoning question and an instruction;
     TTS: two sentences). Note time per output and any warnings in `get_logs`.
   - `delete_model` afterwards to free disk for the next candidate (~60 GB
     per run).

## 5. Open the PR

`gh pr create` on searpro/pepper-catalogue with: what the model is and why it
earns a place, the fit-check table, the quantization tested, timings on the
Kaggle GPU, links to sample outputs if the user wants them kept, and the
sources. If it should join a Kaggle model pack, propose the change to
`deploy/kaggle/packs/*.json` in a separate Pepper PR (packs are capped at
~19 GB).
