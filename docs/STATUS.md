# Status

Where Pepper stands, for the next session to pick up from. Keep it current
rather than appending (`.claude/skills/session-handoff`). Measured numbers
say what they were measured on; everything else is not measured.

Last updated: 2026-10-20 (LoRA library, Qwen-Image 2.1 Turbo, generation time on every file).

## Resume here

**LoRA library and Qwen-Image 2.1 Turbo** (2026-10-20, not yet on a GPU):

- **LoRAs** from a Civitai page, a HuggingFace repository or file, or any
  `.safetensors` link: the LoRAs screen looks the link up (trigger words,
  base model, size, hash), downloads it once into `models/loras/library/`,
  and any recipe on the same base runs it at a chosen strength (Generate's
  LoRA picker; `loras` on `/v1/jobs`, `/v1/generate` and the MCP generate
  tools; `install_model` with `lora_url`). Eleven recipes take them: the
  Qwen-Image 2.1 three, Krea 2, Z-Image, FLUX.2 klein, H3 and H3 reference,
  LTX-2.5, InfiniteTalk one and two. `CIVITAI_TOKEN` for files that need an
  account. In projects, a cast member carries its LoRAs (one per model it
  is rendered with) and a shot adds or mutes them (strength 0); each take
  runs those its recipe's base can, trigger words added to the prompt, and
  long takes and retakes keep them in every segment. A shot with no recipe
  picks a suitable one that runs its LoRAs, and LoRAs a recipe cannot run
  are reported (`skipped_loras`). Lookups were checked
  against live Civitai and HuggingFace entries; a LoRA has not yet been
  rendered through ComfyUI.
- **`qwen-image-turbo`** (text to image, `final` at 1 MP and `2k`) and
  **`qwen-image-turbo-edit`** (up to four images) run Comfy-Org's Turbo
  checkpoint with the official templates' 8-step ManualSigmas schedule at
  CFG 1, the int8 files on `16gb`–`32gb`. Same encoder and VAE as
  `qwen-image-edit`. Research licence, like the base.
- **Generated files carry how they were made** everywhere they are shown
  (Media, Generate, Jobs, takes, the library picker): generation time, queue
  wait, prompt, seed, recipe and mode, LoRAs, in one shared viewer;
  portrait media display whole.

Next: render both Turbo recipes and one LoRA per base on the home box and
fill in `verified`.

**Maya's channel intro** (2026-10-19): 58 s, 9:16 4K, outdoors at golden
hour in a new outfit (a Qwen-Image edit of her library still, 26 s on
`16gb`), every line with its own camera move: push-in, ~20° arc, sideways
truck, walk toward a backward-tracking steadicam, pull-back. All held eye
contact and lip sync. Two takes failed because the direction asked for a
smile through the line (the mouth froze in a grin); the skill now says how
to direct around it. The box runs the published `pepper-pro:cu130` image.
The files live outside the repo in `~/projects/maya-intro`.

**Publishing is manual, through Notion** (2026-10-19): no upload automation
and no platform API reviews. The `presenter-explainer` skill's step 7 writes a
publishing kit per video (Qwen-Image-designed thumbnails with real subject
photos laid in by `scripts/covers.py`, titles, descriptions, tags and
captions per platform) to `publish-kit.md` and to the **Video Publishing**
workspace in Notion (Channels, Videos, Performance; IDs in
`presenter-explainer/references/notion.md`). Performance is logged from
analytics screenshots at 24 h, 7 d and 30 d. Active platforms: YouTube
Shorts, Instagram Reels, Facebook Reels; TikTok is inactive (blocked in
India). First channel: Now It Clicks · by Maya, with the intro and the
Roadster explainer ready to post. The `qwen-image-edit` model is
non-commercial: check before the channel is monetised.

**A researched presenter explainer, end to end on the home box** (2026-10-18):
"How the Tesla Roadster defies gravity", 2:04, 9:16 4K. Maya (a Krea 2
still) speaks every line in one Qwen3-TTS voice, cloned from one designed
clip; `h3-video` `draft` lip-syncs each line from that audio (the speech
lands within 0.02 s of the line); RTX Video masters to 2192×3840; ACE-Step
makes the bed; a compositor on the laptop lays real photos of the car over
her (the user rejected generated car shots). The whole procedure, scripts
and that video's cue sheet are the `presenter-explainer` skill. 3.7 GPU-hours
including two retakes and a dropped approach.

Same day:

- **Video saves were throwing detail away.** SaveVideo `auto` came out
  near CRF 23: H3 takes at 768×1344 were 1.2 Mbps and 4K masters 7.3 Mbps,
  which is where the soft skin came from. The chain now saves H.264 at
  CRF 12 (H3, H3 reference, LTX refine, SeedVR2) and 14 (RTX master): the
  same take is 7.7 Mbps and its master 56 Mbps, with the forehead texture,
  freckles and lashes back (an A/B at one seed). `final` mode (20 steps)
  adds a little more at twice the time (11 min per 5 s); SeedVR2 ×2 on the
  take, then RTX ×1.43, gives the most real skin (pores, lashes) for
  +18 min per 5 s at 1536×2688 (65 Mbps), lip sync kept.
- **Character library over MCP:** `get_project` with no id lists the
  shared library and `library: true` on a plan asset saves there; a plan
  naming a library character binds to it without rewriting it. Maya is
  `ast_70ea1af4d2eb` (still, voice clip, its transcript in `meta`).
- **The Media page lost files on restart** because of the day-long output
  retention sweep, which also runs at boot. The home launcher now sets
  `OUTPUT_RETENTION_MS=0`; the user deletes outputs themselves.
- `qwen3-tts` and `ace-step-music` run on `16gb`.
- The box runs `pepper-pro:local`, built from this branch with the CUDA 13
  torch index (`up --build --build-arg TORCH_INDEX=…/cu130`).

Next:

1. **More channels:** each is a row in Notion's Channels database with its
   own style guide; the user wants to grow aggressively.
2. **Explainers inside Pepper:** a cut that overlays photos, captions and
   stat callouts (what `presenter-explainer/scripts/compose.py` does on the
   laptop), and a route to import a finished file as a take, so a video
   like the Roadster one is a project rather than loose outputs.
3. **Make the approved dialogue path the default:** `masterTake` runs RTX
   only for dialogue shots (or a project setting), shots with dialogue
   render in `draft` at full size, and `plan_project`'s guidance tells
   Claude about calm direction, eyelines and Krea stills.
4. **FLUX 3 Image Klein** (open weights, 15 Oct) as a still model to A/B
   with Krea 2: the user accepts its licence on
   `black-forest-labs/flux-3-image-klein-comfy`, and the image moves to
   ComfyUI 0.41+ (we pin 0.38.1), re-validating every recipe.
5. **Short drama, still untested:** two characters in one frame (a
   composed first frame of both). Voice consistency across a character's
   shots is solved for narration (design once, clone every line).
6. Check the other NVFP4 files against int8 at the same seed
   (`scail2-replace`; the LTX refine's int8 files are on the box).

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
  NVIDIA's own VFX where they help. H3's NVFP4 build did not: it cost
  quality at no gain in speed (2026-10-17), so compare any NVFP4 file with
  int8 at the same seed before adopting it.
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
| `h3-video` | half (int8, EMA turbo v4, 4 steps) | the Civitai sample's shot 448×576, 7 s in 69 s; 672×384, 5 s in 46 s |
| `ltx25-refine` | x2 | 672×384 → 1344×768 in 89 s cold; 576×1024 → 1152×2048 in 205 s, 23.5 GB RAM + 4.2 GB swap |
| `rtx-master` | upscale ×2.5 ULTRA | 2240×2880 in 26 s; 3360×1920 in 15 s; driver 595 fine |
| `krea2-image` | — | 9:16 still in about 15 s warm (fp8); the still model for people |
| `qwen3-tts` | design, final (clone) | A 10 s line in 5–10 s warm. Design one voice, then clone it with `voice_text` for every line: one voice across a whole piece (2026-10-18) |
| `ace-step-music` | final | 130 s instrumental bed in 11–18 s |
| `h3-video` | draft, driven by `audio` | 768×1344, 10 s lip-synced to a qwen3-tts line in ~14 min; the speech lands to within 0.02 s of the line |
| `zimage-turbo`, `flux2-klein-edit`, `qwen-image-edit` | — | Rendered correctly, checked by eye, with the `24gb-64ram` files (no 16gb variants); not timed |

Details and the rest of the measurements are in `docs/H3-16GB.md` §6.
`infinitetalk`, `infinitetalk-duo` and `qwen3-tts` were
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
  - `presenter-explainer`: research → script → one cloned voice → H3
    lip-sync → RTX master → photos, captions and music composed on the laptop.
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
