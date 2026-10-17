# Status

Where Pepper stands, for the next session to pick up from. Keep it current
rather than appending (`.claude/skills/session-handoff`). Measured numbers
say what they were measured on; everything else is not measured.

Last updated: 2026-10-17 (finishing chain verified and A/B'd on the home box).

## Resume here

The MiniMax × LTXV finishing chain is verified on the home box and A/B'd
against a draft mastered with SeedVR2 (`docs/H3-16GB.md` §6). Results:
denoise 0.3 and RTX ULTRA stay as they are, `smooth` works, and **the base
size is what decides quality**. Next:

1. **Raise the size `half` derives.** At 0.5× of 1344×768 the master is
   softer than a plain draft. At the samples' size (H3 at 1024×576 for
   16:9, a 3072×1728 master) it matches the SeedVR2 baseline in 4.7 min
   against 14.4. The refine then peaks at 25.8 GB of RAM for 5 s, so check
   a 10 s take before making it the default. 0.6× (800×448, 24.1 GB) is
   the safer middle.
2. **Keep the chain as the default master**; SeedVR2 for damaged takes.
3. CQ-only against CQ + Crisp needs a LoRA parameter on `ltx25-refine`.
   LTX's IC-LoRA Refine-Details and the VFX runtime's licence are still
   open.

`deploy/home/.env` does not exist on the laptop: pass
`--host lijin@lk-gpu-server` or add `PEPPER_HOME_HOST` there. The launcher
now forwards `HF_TOKEN` (or the `hf auth login` token), which LTX-2.5's
gated repo needs.

## Standing directions from the user

- **The home box is the primary target**, not RunPod or Vast.ai: "we are no
  longer working for deployment on vast ai or runpod. Our primary target is
  the local server." The cloud launchers stay working, but nothing is
  designed for them first.
- **Quality is the goal**, measured against the samples of workflows the
  user brings: "When I give you a workflow or link, it's your task to
  analyze and make full utilisation of the resources you get from that link
  or workflow. DO NOT STICK WITH SOMETHING JUST BECAUSE WE HAVE DONE THE
  GROUNDWORK ALREADY." (`.claude/skills/workflow-to-recipe`.)
- **Use the NVIDIA GPU fully.** Prefer NVFP4 files, Kitchen attention and
  NVIDIA's own VFX where they help.
- **Keep both products and Kaggle support.**

## The home box

| | |
| --- | --- |
| GPU | RTX 5060 Ti 16 GB (Blackwell), driver 595 |
| Host | Ryzen 5 7600X, 32 GB DDR5 single channel, 1 TB SSD |
| Runs | `uv run deploy/home/launch.py up --product pro`: `16gb` tier, `ghcr.io/searpro/pepper-pro:cu130` (CUDA 13, torch 2.14.1+cu130), Kitchen attention on |
| Limit | Host RAM, not VRAM. Paging shows as a flat ~35 W at "99 %" GPU use. |

`up` holds the tunnel hostname until `down`, so never run it alongside a
cloud `up`. The `pepper` MCP server reaches whichever instance is up. When
none is, its tools are missing.

## Pepper Pro

### Verified on the home box (16gb)

| Recipe | Mode | Result |
| --- | --- | --- |
| `h3-video` | draft (8-step turbo) | 1344×768, 6 s in 390 s; 15.7 GB VRAM / 18.5 GB RAM. Continuing take 445 s; seam invisible. |
| `scail2-replace` | draft | 640×640, 81 frames in 335–397 s (NVFP4) |
| `seedvr2-upscale-video` | 2× | 640² → 1280², 81 frames in 247 s |
| `h3-video` | half (turbo v4, 4 steps) | 672×384 in 51 s; 576×1024 in 77 s (5 s each) |
| `ltx25-refine` | x2 | 672×384 → 1344×768 in 89 s cold; 576×1024 → 1152×2048 in 205 s, 23.5 GB RAM + 4.2 GB swap |
| `rtx-master` | upscale ×1.5 ULTRA | 2016×1152 in 17 s; 1728×3072 in 18 s; driver 595 fine |
| `zimage-turbo`, `flux2-klein-edit`, `qwen-image-edit` | — | Rendered correctly, checked by eye, with the `24gb-64ram` files (no 16gb variants); not timed |

Details and the rest of the measurements are in `docs/H3-16GB.md` §6.
`krea2-image`, `infinitetalk`, `infinitetalk-duo` and `qwen3-tts` were
verified on a 32 GB cloud card only.

### The MiniMax × LTXV finishing chain (verified 2026-10-17)

This reproduces the Civitai "MiniMax x LTXV Low VRAM" workflow (SonicLoops
v3, model 2883915) as separate jobs:

1. `h3-video` in `half` mode: half size, turbo v4 LoRA, 4 steps, beta, CFG 1,
   sigma shift 12/3.
2. `ltx25-refine`: 2× latent upscale, 3 steps at denoise 0.3, CQ LoRA (1.0)
   and Crisp LoRA (0.8), first frame pinned, H3's audio kept.
3. `rtx-master`: RTX Video Super Resolution ×1.5 ULTRA. `smooth` mode adds
   RTX Frame Generation ×2.

Mastering a take (`masterTake`, the shot dialog's Master button, or
`POST /v1/takes/:id/master`) runs steps 2 and 3. A 5 s portrait at the
samples' size (1728×3072) takes about 5 min in all, and up close its faces
match the samples. The refine keeps identity and fixes H3's half-size
faults. The 16:9 default size is softer (Resume here, item 1).

Open:

- Whether LTX's IC-LoRA Refine-Details is worth adding.
- Whether NVIDIA's VFX runtime may be redistributed in the image
  (`rtx-master` licence note).
- Speech in the half takes was not transcribed (no Whisper on the laptop).

### Other open items

- **LongCat-Avatar:** the full-length draft was killed at segment 11 of 17
  by the 1 h `COMFY_TIMEOUT`. The timeout was never raised per recipe.
- **Influencer video:** the "Ellie" project (affiliate marketing script,
  voice V6 Australian, H3 drafts of shots 1–8) lives in the cloud instance's
  data, not in git.
- **Cloudflare edge design:** an always-on Worker for the API, MCP, jobs
  and media, with GPU boxes as agents pulling jobs. It was discussed in
  Phases 0–4, but nothing is written or built. The home box would be the
  first agent.
- **Recipes never run on any GPU:** `ace-step-music`, `h3-reference`,
  `longcat-avatar`, `ltx23-audio-to-video`, `ltx25-video`,
  `ming-image-design`, `minimax-music-3`, `seedvr2-upscale-image`,
  `wan-animate2`, `wan-dancer`.

## Pepper

Unchanged since the RunPod quality refresh (September): sd-cli, llama.cpp,
audio.cpp and the Python runners on a 24 GB pod or Kaggle. The catalogue is
in `searpro/pepper-catalogue`.

## Working on this repo with Claude

- **Skills** (`.claude/skills/`):
  - `pepper-dev`: change → local checks → GPU.
  - `workflow-to-recipe`: a ComfyUI workflow → recipes.
  - `session-handoff`: pull context in, and keep this file up to date.
  - `catalogue-curator`: research models for Pepper's catalogue.
- **Agents** (`.claude/agents/`):
  - `model-file-scout`: files, sizes and checksums per tier.
  - `recipe-reviewer`: a recipe diff against the contract.
  - `session-historian`: digests a large transcript.
- **Tools:**
  - `npm run inspect-workflow -w @pepper-pro/server -- <ui.json>`: what a
    UI workflow really does.
  - `npm run convert-template`: UI to API format.
  - `npm run validate-recipes`.
