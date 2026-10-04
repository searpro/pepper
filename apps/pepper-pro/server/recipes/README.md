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
| `wan22-video` | video | A keyframe brought to life, or a move between a first and a last frame; silent, high detail | Apache 2.0 |
| `ltx23-audio-to-video` | video | One image performing to a finished track or recorded line | LTX-2 (under $10M) |
| `seedvr2-upscale-video` | video | Finishing: restore and upscale a chosen take | Apache 2.0 |
| `infinitetalk` | video | A portrait lip-synced to a voice recording, 3-12 s | Apache 2.0 |
| `infinitetalk-duo` | video | Two people in one frame, each lip-synced to their own line (left speaks first) | Apache 2.0 |
| `longcat-avatar` | video | A portrait speaking or singing a long recording (minutes) with body and hand motion | MIT |
| `scail2-replace` | video | Re-cast a person in an existing video with the character in one image | MIT; SAM licence (tracker) |
| `wan-animate2` | video | A character performing a driving video's motion (dance, walk) | Apache 2.0 |
| `wan-dancer` | video | A character dancing to a music track, choreographed to its beat | Apache 2.0 |
| `krea2-image` | image | Photoreal stills, keyframes, looks | Krea 2 (under $1M) |
| `zimage-turbo` | image | Fast permissive stills | Apache 2.0 |
| `qwen-image-edit` | image | Edits and combining images (try-on, product placement) | Research only |
| `flux2-klein-edit` | image | Quick permissive edits, and try-on with a second image | Apache 2.0 |
| `seedvr2-upscale-image` | image | Restore and upscale a still | Apache 2.0 |
| `ming-image-design` | image | UI screens, posters and infographics with legible text | MIT |
| `ace-step-music` | audio | Songs from style tags and lyrics, fast | MIT |
| `minimax-music-3` | audio | Produced songs, slower | Apache 2.0 (per the Comfy-Org repackage) |
| `qwen3-tts` | audio | Speech: a cloned voice, a described voice, nine presets, or a dialogue of up to four voices | Apache 2.0 |

None of these has been run on a GPU yet: the `verified` field is absent on
all of them until a golden-shot run fills it in. `qwen3-tts` is the one that
has produced real output, on a CPU ComfyUI (preset, cloned and dialogue
speech, checked by Whisper).

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

## Adding or changing a recipe

1. Convert the ComfyUI template (UI format) to API format with a running
   ComfyUI: `CHROMIUM_PATH=… npm run convert-template -- template.json > workflow.json`.
2. Wire it: bind parameters and files, drop prompt enhancers (Claude writes the
   prompt), give optional inputs their own loader nodes.
3. `npm run validate-recipes -- --comfy http://127.0.0.1:8188 --write-fixture test/fixtures/object_info.json`
   builds every mode with and without optional inputs and validates it against
   that ComfyUI, and refreshes the node types the unit tests check against.
4. Render the golden shots on a pod and fill in `verified`.
