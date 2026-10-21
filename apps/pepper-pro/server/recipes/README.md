# Recipes

A recipe is a pinned ComfyUI pipeline: the graph, the exact model files for
each hardware tier, the custom node packs, and how a request's parameters
reach the graph. The format is `src/recipes/schema.ts`; the reasons are in
`docs/PEPPER-PRO.md` §6. Recipes ship in the image (a new recipe usually means
a new node pack, which is an image change anyway), so there is no remote
catalogue for them.

```
recipes/<id>/
  recipe.json      metadata, files, params, bindings, modes
  workflow.json    ComfyUI API-format prompt (what /prompt takes)
```

| Recipe | Kind | What it is for | Licence |
| --- | --- | --- | --- |
| `h3-video` | video | Video + sound from a prompt, first/last frame, driving audio (lip-sync) or a clip to continue | MiniMax H3 (under $20M; not US/EU/UK/KR) |
| `h3-reference` | video | A recurring cast from reference pictures and voice clips; dialogue scenes | MiniMax H3 |
| `ltx25-video` | video | Fast b-roll and transitions between two keyframes | LTX-2.x (under $10M) |
| `ltx23-audio-to-video` | video | One image performing to a finished track or recorded line | LTX-2 (under $10M) |
| `seedvr2-upscale-video` | video | Finishing: restore and upscale a chosen take | Apache 2.0 |
| `ltx25-refine` | video | Finishing: re-render a take's detail with LTX 2.5, at twice its size for an H3 `half` take; motion, lip-sync and sound kept | LTX-2.x (under $10M) |
| `rtx-master` | video | Finishing: NVIDIA RTX Video upscale (and 2× frame rate in `smooth` mode) on the card, in seconds | NVIDIA VFX SDK; nodes MIT |
| `film-finish` | video | Finishing: the presenter look (grade, halation, diffusion, aberration, grain) on the card, out as SDR, HDR10 or HLG; matches takes to a hero take | Pepper Pro's own node |
| `infinitetalk` | video | A portrait lip-synced to a voice recording, 3-12 s | Apache 2.0 |
| `infinitetalk-duo` | video | Two people in one frame, each lip-synced to their own line (left speaks first) | Apache 2.0 |
| `longcat-avatar` | video | A portrait speaking or singing a long recording (minutes) with body and hand motion | MIT |
| `scail2-replace` | video | Re-cast a person in an existing video with the character in one image | MIT; SAM licence (tracker) |
| `wan-animate2` | video | A character performing a driving video's motion (dance, walk) | Apache 2.0 |
| `wan-dancer` | video | A character dancing to a music track, choreographed to its beat | Apache 2.0 |
| `krea2-image` | image | Photoreal stills, keyframes, looks | Krea 2 (under $1M) |
| `zimage-turbo` | image | Fast permissive stills | Apache 2.0 |
| `qwen-image-turbo` | image | Stills in 8 steps, native 2K: large detailed stills, posters, UI and text | Research only |
| `qwen-image-turbo-edit` | image | `qwen-image-edit` in 8 steps instead of 25, up to four images | Research only |
| `qwen-image-edit` | image | Edits and combining images (try-on, product placement) | Research only |
| `flux2-klein-edit` | image | Quick permissive edits, and try-on with a second image | Apache 2.0 |
| `seedvr2-upscale-image` | image | Restore and upscale a still | Apache 2.0 |
| `ming-image-design` | image | UI screens, posters and infographics with legible text | MIT |
| `ace-step-music` | audio | Songs from style tags and lyrics, fast | MIT |
| `minimax-music-3` | audio | Produced songs, slower | Apache 2.0 (per the Comfy-Org repackage) |
| `yue2-music` | audio | The best open songs: a melody-and-chord score written first, then sung; covers of a recording and edited scores sung again | CC BY-NC 4.0 (non-commercial) |
| `qwen3-tts` | audio | Speech: a cloned voice, a described voice, nine presets, or a dialogue of up to four voices | Apache 2.0 |

A recipe's `verified` field records the date, GPU and seconds of the run
that proved it; one without it has only been validated structurally.
`docs/STATUS.md` lists which ran on the home box's `16gb` tier.

## Parameter names are a contract

Projects turn a shot into a recipe's parameters **by name**
(`src/projects/derive.ts`), so a new recipe works with the storyboard without
code as long as it uses these names:

| Name | Type | Filled from |
| --- | --- | --- |
| `prompt` | text | The composed shot prompt (style, subjects, direction, dialogue, sound) |
| `first_frame`, `image` | image | The shot's first keyframe, else its first asset picture |
| `last_frame` | image | The shot's last keyframe |
| `refs`, `reference_images` | images | Pictures of the shot's assets, in order (`max_items` caps it) |
| `audio` | audio | The shot's driving audio asset |
| `voice_refs` | audios | Voice clips of the speakers, in speaking order |
| `duration`, `seconds` | int/float | The shot's length, clamped to `min`/`max` |
| `width`, `height` | int | The project's aspect at the **mode's** default pixel count |
| `fps` | int/float | The project's frame rate |
| `seed` | seed | Drawn per take; reused when a draft is finished |

A video recipe a shot can render with (one with a `prompt`) has a `draft`
and a `final` mode. Capabilities (`dialogue`, `subject-tags`, `lip-sync`,
`first-frame`, `text-to-video`…) decide which recipe a shot kind gets when
the shot names none (`ProjectService.recipeFor`).

## Continuation: long takes and retakes

A recipe with a `continuation` block (`{ "param": "previous", "overlap_s":
0.9167 }` on `h3-video`) can continue a clip: `param` is a `video` input
whose tail opens the new clip, which repeats `overlap_s` seconds of it. The
project service uses it for two things (`src/projects/chain.ts`):

- A shot longer than the recipe's `duration` max is rendered as segments,
  each continuing the one before; the first keeps the shot's first frame,
  dialogue and driving audio, the last ends on its last frame, and the
  joined take has the overlaps cut out, picture and sound at the same seam.
- A retake keeps a finished take up to a second and renders the rest again
  from there (`POST /v1/takes/:id/retake`, or `render_shots` with
  `from_take` and `retake_from`), as a new take beside the original.

## LoRAs from the library

LoRAs are not recipe files. The library (`src/loras/`, the LoRAs screen,
`/v1/loras`) downloads them from Civitai, HuggingFace or any `.safetensors`
link into `models/loras/library/`, and any recipe built on the LoRA's base
model can run them. A recipe opts in with two fields:

- `lora_base` (recipe): the base model a LoRA must be made for, one of
  `src/loras/bases.ts` (`qwen-image-2.1`, `krea-2`, `z-image`,
  `flux2-klein-4b`, `minimax-h3`, `ltx-2.5`, `wan-2.1-14b`, `yue2`).
  Recipes on one base share every LoRA made for it.
- `lora_targets` (workflow): `[{ "node": "451", "output": 0 }]`, the node
  whose MODEL output the LoRAs patch, normally the diffusion model's
  `UNETLoader`. A request's LoRAs become a chain of `LoraLoaderModelOnly`
  nodes after it, and everything that read it reads the chain's end. A
  workflow without targets takes none, so one mode can refuse what another
  accepts.

`validate-recipes` and the unit tests build every workflow with targets with
two sample LoRAs, so a target that is not a MODEL output fails there. Two
models in one graph (Wan 2.2's high- and low-noise experts) want LoRAs in
pairs, which this does not model yet; those recipes have no targets.

## Bindings

- `{ param, node, input }` sets one input; `map` turns an enum's option into
  the value the graph wants (Wan-Dancer's style is an index).
- `{ param, nodes: [...] }` fills slots in order; slots left empty are
  **pruned** with whatever only they fed, and an optional input they fed is
  dropped. Single optional media (a last frame) use this form with one slot,
  so leaving it out removes its loader instead of loading a stale name.
- `{ file, node, input }` puts the installed file name for this tier into a
  loader.
- A workflow's `bypass` list names guide nodes that pass an input through when
  what they need is absent (`MiniMaxH3AddGuide` with no audio passes
  `positive` through).

Mode `set` entries fix constants (the turbo switch) or rewire an input (a
final mode's length linked to the driving video's frame count), and mode
`defaults` override parameter defaults (a draft's smaller size). A mode may
also pick a different workflow file: InfiniteTalk's draft, final and long
modes are one, two and four chained 81-frame windows.

A mode's `required` lists parameters it needs although the recipe does not
(YuE2's `cover` needs `audio`, its `score` mode a `score`). A request without
them is refused before anything loads, and a generic request (`/v1/generate`,
the MCP tools) that gives all of them gets that mode without naming it. The
Generate screen shows only the parameters a mode's workflow binds.

## Text outputs

An output `{ "node": …, "kind": "text" }` names a `PreviewAny` node whose
text becomes the job's `text` (what `get_job` shows) instead of a file; a
workflow still needs a file output, which comes first. YuE2 returns its ABC
score this way, and the Generate screen shows it under the song with a button
that sings it again in `score` mode.

## YuE2

`yue2-music` is Comfy-Org's two templates (text to music, music cover) on
ComfyUI's native nodes. A song is two language-model passes and a short
diffusion: `YuE2GenerateABC` writes the song as an ABC score (melody, and
chords in `full`), `YuE2GenerateMusic` generates 25 Hz semantic tokens
against it (the long part, and where `max_duration` caps the length), and a
32-step `dpm_2`/`sgm_uniform` pass at CFG 1 renders them into the VAE's
48 kHz stereo. Its four modes are what the model can do: `song` plans then
sings and returns the score; `free` sings with no score (the model's `off`
mode, with its own CFG of 1.01, in a graph that has no score input); `score`
sings a given score, which is how a tune is kept while the style or words
change, or edited note by note; `cover` transcribes a recording's melody
with SheetSage2 (`plan: melody`, as the authors advise) and sings it in a
new style. The templates load Comfy-Org's int8 checkpoint; the recipe uses
the bf16 one on every tier, since it fits 16 GB with room (the reference
pipeline peaks at 11-14 GB). Library LoRAs (`lora_base: yue2`) patch the
music model only, not the planner.


## Film finish

`film-finish` is the one recipe whose node lives in this repository
(`comfy-nodes/pepper_finish`, named in `nodes` by `path` and linked into
ComfyUI by `install-comfy.sh`). A ComfyUI IMAGE batch is the wrong shape for
a look over a whole 4K take: a 10 s 2192×3840 take is 24 GB as float32
frames. `PepperFilmFinish` takes the take's file and writes the finished one
itself, streaming: ffmpeg decodes raw YUV, torch does the picture in 32-bit
float on the card, x264 or x265 encodes on the CPU, all three at once, so
memory stays flat and the encode sets the speed. Its `report` output (a
PreviewAny) is the job's text: seconds, HDR light levels, how a take matched.

The picture works in linear light with headroom: a take's SDR values go
through the inverse of a soft highlight shoulder (linear up to 0.6, SDR white
→ 4× diffuse white), the look runs there (exposure and contrast on light,
halation and a Pro-Mist bloom added as light, radial chromatic aberration,
a vignette as exposure falloff, grain in log exposure), and the output is the
shoulder back to SDR, or the same light with SDR white at 203 nits (BT.2408)
in BT.2020 PQ or HLG. An ungraded take round-trips exactly; HDR keeps skin
and walls where the SDR grade put them and lifts only what the shoulder had
compressed. `strong`/`medium`/`subtle` port the presenter skill's ffmpeg
filtergraph step for step, down to ffmpeg's 8-bit blend truncation and its
vignette running on limited-range YUV (it takes no planar RGB), so the
chosen look is unchanged. `match` compares a take's skin (or, when the set
is skin-coloured too, the frame) with a hero take's and nudges exposure and
white balance, at most a stop and 12% per channel. `expand: rtx` hands the
graded SDR picture to NVIDIA RTX Video HDR instead (needs rtx-master's pack).
`masterTake` runs it last when given `finish` (a look), in SDR; HDR takes are
made with `generate_video` and composed elsewhere.

## Adding or changing a recipe

1. Read what the workflow really does: `npm run inspect-workflow --
   workflow.json --object-info http://127.0.0.1:8188` (active nodes, packs,
   files, LoRAs, sampler settings, prompts, notes). Then convert it to API
   format with a running ComfyUI:
   `CHROMIUM_PATH=… npm run convert-template -- template.json > workflow.json`,
   or rebuild the active chain by hand when it is mostly canvas plumbing.
   The `workflow-to-recipe` skill (`.claude/skills/`) is the whole procedure.
2. Wire it: bind parameters and files, drop prompt enhancers (Claude writes the
   prompt), give optional inputs their own loader nodes.
3. `npm run validate-recipes -- --comfy http://127.0.0.1:8188 --write-fixture test/fixtures/object_info.json`
   builds every mode with and without optional inputs and validates it against
   that ComfyUI, and refreshes the node types the unit tests check against.
4. Render the golden shots on a GPU (the home box or a pod) and fill in `verified`.

A node pack that only loads with an NVIDIA driver (NVIDIA's VFX nodes link
libcuda when imported) is marked `gpu_only` in the recipe's `nodes`. A
CPU-only ComfyUI, like the image build's, cannot describe its nodes, so
`validate-recipes` falls back to the schemas recorded in the recipe's
`node-schemas.json`, taken from `/object_info` (`rtx-master` has one).

## The finishing chain

The MiniMax × LTXV workflow (Civitai, SonicLoops v3) gets its quality from a
chain, which Pepper Pro runs as separate jobs so each fits a 16 GB card and
32 GB of RAM: `h3-video` in `half` mode renders motion, faces and sound at
half the size (turbo v4 LoRA, 4 steps, beta, CFG 1, sigma shift 12);
`ltx25-refine` re-renders it at twice that size in three steps at denoise
0.3 (spatial upscaler, the Crisp LoRA, the take's first frame pinned, one
untiled decode);
`rtx-master` upscales on the card with RTX Video, ×2.5 as the samples do
(a master is capped at 4K). Mastering a take runs the refine and then the
upscale by default (`masterTake`). On `16gb` H3 must be the pruned **int8**
model, as in the workflow: the NVFP4 build washed out contrast and changed
faces at the same seed (`docs/H3-16GB.md` §6). The samples' MP4s carry the
workflow and API prompt that made them (ffprobe tags `workflow`, `prompt`),
which is the way to rerun one and compare. For dialogue, skip the refine: it
re-renders mouths without the audio, so lips drift from H3's sound. Render
speaking shots in `h3-video` `draft` at full size and master them with
`rtx-master` alone (`docs/H3-16GB.md` §7).
