---
name: workflow-to-recipe
description: Turn a ComfyUI workflow (a Civitai download, a template, a canvas save, a workflow embedded in a sample PNG) into Pepper Pro recipes that reproduce its output quality on the user's hardware — read what is actually switched on, find the exact model files per tier, split it into jobs that fit the RAM, wire recipe.json and an API-format workflow.json, validate, document, and verify on the GPU. Use when the user shares a workflow JSON or link and wants that quality in Pepper Pro, or asks why our results fall short of a workflow's samples.
---

# Workflow → recipe

The user hands over a workflow because its **samples** look better than what
Pepper Pro makes. The job is to reproduce that quality, not to file the
workflow under the nearest recipe we already have. Two rules from the user,
both learnt the hard way:

- **Use everything the workflow gives you.** Its LoRAs, enhancer LoRAs,
  latent upscalers, sigma shifts, step counts, schedulers, prompts, VFX
  stages and the author's notes are the recipe. Read every setting.
- **Don't keep something because we built it already.** If the workflow's
  chain beats ours (it beat SeedVR2 mastering with LTX refine + RTX Video;
  `wan22-video` was dropped for not being good enough), replace ours, and
  delete what it supersedes.

The primary target is the **home box** (`16gb` tier: RTX 5060 Ti 16 GB,
32 GB single-channel RAM, 1 TB SSD, driver 595, the `pepper-pro:cu130`
image). Cloud tiers come second. `docs/STATUS.md` says what runs there now.

## 1. Get the real workflow

- Civitai downloads need a login (401 from here). Ask the user to upload the
  `.json` (or the zip). A sample PNG/WebP often embeds the workflow in its
  `workflow`/`prompt` metadata: read it with Pillow if that is all there is.
- Also read the model page: version notes, the changelog (it lists known
  faults and their fixes) and the sample generations' sizes, lengths and
  frame rates. Those samples are the bar the result is judged against.

## 2. Read what is switched on

```bash
cd apps/pepper-pro/server
npm run inspect-workflow -- <workflow.json> --object-info http://127.0.0.1:8188 > /tmp/…/inspect.txt
```

It flattens subgraphs, and reports node packs (with the `ver` commits the
author had), groups with on/off counts, model files, LoRAs and strengths,
sampler/scheduler/sigma settings, prompts, the author's notes (deduplicated),
and every active node's named widget values. Bypassed (mode 4) and muted
(mode 2) nodes are left out unless `--all`. Point `--object-info` at a
ComfyUI at our pinned version (`scripts/install-comfy.sh`, CPU torch is
fine), not the test fixture: the fixture is only the types our recipes
already use, so everything else shows as not in object_info.

Then sort every active node into one of four kinds:

| Kind | Examples | In Pepper |
| --- | --- | --- |
| Core ComfyUI | samplers, `LTXVLatentUpsampler`, `MiniMaxH3SigmaShift`, `ComfyMathExpression` | Keep as is |
| Canvas plumbing | KJ Set/Get, `TwoWaySwitch`, rgthree bypassers, `ImpactExecutionOrderController`, previews, notes | Bindings, modes (`set`), `bypass` |
| Memory and speed hacks | `RAMCleanup`, `easy cleanGpuUsed`, Sage patches, torch settings, chunked feed-forward | Drop: the engine frees models on a family switch, separate jobs do the rest, ComfyUI starts with Kitchen attention |
| A real custom pack | RTX VFX, RIFE, a model's own nodes | Pin by commit in `nodes`, allow-listed in the image; `gpu_only` if it needs the driver to import |

Write down the quality chain in one paragraph (what renders, at what size,
what refines it, what finishes it). That paragraph goes in
`recipes/README.md` later.

## 3. Find the files, per tier

Every file needs `repo`, `path`, `bytes` and, where HF exposes one, `sha256`
for each tier that can run it (`16gb`, `24gb-64ram`, `32gb`, `48gb`, `96gb`).
Hand this to the **`model-file-scout`** agent with the file names from step
2; it returns the table. Rules:

- Authors rename files (`LTX\ltx2.5-CQ-enhancer…`, `…_comfyui.safetensors`):
  find the upstream repo, not a reupload.
- Prefer official or Comfy-Org files. A community file is fine when the
  quality depends on it (the turbo v4 LoRA, the Crisp and CQ LoRAs), but
  pin its checksum.
- `16gb` usually means NVFP4 (Blackwell, cu130 image) or a pruned build.
  A file with no variant for a tier falls back to the nearest larger
  tier's variant (`variantFor` in `src/recipes/store.ts`). That fallback
  is fine for a 6 GB image model and fatal for a 22 GB video transformer,
  so either write the `16gb` variant or leave `16gb` out of the recipe's
  `tiers`, which is what refuses it there.

## 4. Fit it to the RAM

On the home box, **host RAM is the limit, not VRAM**: two 20 GB+ model
families in one graph reload from the SSD on every run. Split by family
into separate jobs:

- One family per recipe. Chain them in the service the way `masterTake`
  does (each step reads the last step's output, with a step counter for the
  UI), or as a mode of an existing recipe when it is the same family
  (`h3-video`'s `half` mode).
- Keep the soundtrack from the stage that made it. A refiner gets the
  source's audio passed through, never regenerated.
- Pin what the workflow pins: the take's own first frame, the seed, the
  fps.

## 5. Build workflow.json

Two ways:

- **Convert** a clean template with
  `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run convert-template -- template.json > workflow.json`
  (needs a running ComfyUI with the workflow's packs; subgraphs and seed
  widgets are handled by the frontend itself).
- **Hand-write it** when the graph is mostly plumbing (as with SonicLoops):
  rebuild only the active chain from the step 2 settings, in API format.
  Number the nodes in blocks (1–9 input, 10–19 models, 20–29 sizes, 30+
  conditioning, 40+ sampling, 50+ output) so recipes stay readable.

Mind these, each of which cost a GPU run once:

- LTX's VAE encodes 1+8k frames and drops the rest: pad with copies of
  the last frame (`ImageFromBatch` → `RepeatImageBatch` → `ImageBatch`),
  then trim the decode back to the source's `GetImageSize` batch size.
- Seeds come from a `RandomNoise`/`seed` input bound to the `seed` param,
  never a fixed widget value.
- Every save node's `filename_prefix` is overwritten per job by the engine,
  so leave the default.
- Sizes that must be multiples (H3 at 32, LTX at 32 + 8k frames) are
  computed in-graph with `ComfyMathExpression`, so any request size works.

## 6. Write recipe.json

The format is `src/recipes/schema.ts`; the contract is `recipes/README.md`.
Copy the closest existing recipe and change it. Check in particular:

- Parameter names follow the contract table (`prompt`, `first_frame`,
  `video`, `duration`, `width`, `height`, `fps`, `seed`…), so projects fill
  them without code.
- `files` have a variant for every tier that can run the recipe, each
  bound to its loader.
- Modes: a shot-rendering video recipe has `draft` and `final`; extra
  modes rewire with `set`. Optional inputs get their own loader and a
  `nodes: [...]` binding (pruned when absent) or a `bypass`.
- `capabilities` decide where the projects service uses it (`refine`,
  `upscale`, `finish`, `frame-generation`, `first-frame`, `dialogue`…).
- `licence`: the strictest of the models', LoRAs' and pack's terms,
  with obligations spelled out.

A `gpu_only` pack (it imports libcuda) cannot load on CI's CPU ComfyUI.
Record its node schemas once in `recipes/<id>/node-schemas.json`: install
the pack on the CPU ComfyUI with a schema-only stub of its native module
on `PYTHONPATH` (`reference/nvvfx_stub.py` is the one for NVIDIA's VFX
nodes), then save `/object_info/<Type>` for each node it adds.

## 7. Validate locally

```bash
cd apps/pepper-pro/server
npm run validate-recipes -- --comfy http://127.0.0.1:8188 --tier 16gb
npm run validate-recipes -- --comfy http://127.0.0.1:8188 --write-fixture test/fixtures/object_info.json
npx vitest run && (cd ../../.. && npm run typecheck)
```

- Run it at `--tier 16gb` and at the default tier.
- Edit fixtures by hand in their own compact style. A JSON rewrite reformats
  them and buries the change in churn.
- If the service learnt a new chain or capability, add a fixture recipe
  under `test/fixtures/recipes/` and a `describe` block test.
- Hand the diff to the **`recipe-reviewer`** agent before committing.

## 8. Document

- Add or change a row in `recipes/README.md`. Remove rows for anything
  deleted.
- Add the quality-chain paragraph there.
- Update the model's doc (`docs/H3-16GB.md` and similar), `docs/STATUS.md`,
  and an area `CLAUDE.md` if the service changed.

## 9. Verify on the GPU, against the samples

1. Push and merge, then let `image-pro` build `:latest` and `:cu130`. Its
   smoke test validates every recipe.
2. On the home box: `uv run deploy/home/launch.py up --product pro`. No
   billing, but it holds the tunnel hostname, so run `down` before any
   cloud `up`.
3. Install the recipes and render the workflow's own kind of shot, at its
   resolution and length.
4. Put the result next to the Civitai samples. Measure seconds per stage and
   peak VRAM and RAM.
5. A/B the settings the author left open.
6. Fill in `verified` only after looking at the result. Record the numbers
   in the model's doc and in `docs/STATUS.md`.

## Report

Tell the user:

- What the workflow does that we did not.
- What was adopted, and what was dropped and why (with the node kinds from
  step 2).
- Which files run on which tier.
- What was validated only structurally, and what rendered on a GPU, with
  the numbers.
