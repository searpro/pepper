# The model catalogue

Requirement 7: the model manifest is a remote `pepper-catalogue.json` in its own
repository, covering every model kind — text, image, audio and video — in one
file. Pepper fetches it at startup, caches a copy on the volume, and never
ships a curated list of its own.

This document is the schema that repository has to publish against.

## Where it comes from

`CATALOGUE_URL`, default:

```
https://raw.githubusercontent.com/searpro/pepper-catalogue/main/pepper-catalogue.json
```

Resolution order: live fetch → cached copy in `DATA_DIR/cache/catalogue.json` →
an explicit `CATALOGUE_UNAVAILABLE` error. There is deliberately no built-in
fallback list; one would quietly become the real catalogue the first time the
fetch had a bad day.

The fetched copy is re-read every `CATALOGUE_TTL_MS` (default 10 minutes), and
`POST /v1/catalogue/refresh` forces it immediately.

## Shape

```jsonc
{
  "version": 1,
  "updatedAt": "2026-08-15T00:00:00Z",
  "models": [ /* … */ ]
}
```

A duplicate `kind`/`id` pair rejects the whole document — an ambiguous id would
otherwise install whichever entry the lookup happened to hit first.

Unknown fields on a model pass through untouched, so the catalogue repo can
start publishing an attribute before the server understands it.

### A model

```jsonc
{
  "id": "z-image-turbo",           // unique per kind; the default bundle name
  "kind": "image",                 // image | video | audio | llm
  "name": "Z-Image Turbo",
  "description": "Fast 6B text-to-image model.",
  "reference": "https://huggingface.co/…",
  "tags": ["fast", "turbo"],       // free-form; the UI filters on them

  // --- image and video ---
  "loadMode": "diffusion-model",   // model | diffusion-model
  "mode": "image",                 // image | video  ("video" emits -M vid_gen)
  "edit": false,                   // expects reference images at generation
  "defaults": { "steps": 8, "cfg_scale": 1, "width": 1024, "height": 1024 },
  "extraArgs": ["--qwen-image-zero-cond-t"],
  "capabilities": ["s2v"],         // extra abilities; see "Speech-to-video" below
  "s2v": { "audio_flag": "--ref-audio" },

  // --- llm ---
  "params": "8B",
  "activeParams": "3B",            // MoE only: what drives inference cost
  "vision": false,

  // --- audio ---
  "family": "chatterbox",          // must match audio.cpp's model_specs/<family>.json
  "task": "tts",                   // tts | asr | voice-design | voice-conversion
  "audioMode": null,

  "components": [ /* … */ ]
}
```

`loadMode`, `mode`, `defaults`, `extraArgs`, `capabilities`, `s2v`, `family`,
`task` and `audioMode` are written into the installed bundle's `model.json` at
install time. That is
why they belong in the catalogue: without them a fully-downloaded bundle is
still unusable, and a user who has to hand-author a manifest after a one-click
install has not had a one-click install.

### A component

Each component is one file the user ends up with, and one slot in the bundle.

```jsonc
{
  "slot": "checkpoint",            // checkpoint | vae | clip | lora | weights | aux
  "role": "t5xxl",                 // clip components only: which encoder flag
  "label": "Diffusion model",
  "description": "The main weights.",
  "required": true,                // pre-selected in the install dialog
  "quantizable": true,             // user picks between quantizations
  "source": {
    "repo": "Comfy-Org/z-image-turbo",
    "path": "split_files/diffusion_models",  // optional sub-folder
    "match": "z_image",            // optional case-insensitive filename filter
    "extensions": [".gguf", ".safetensors"],  // optional; defaults to weight formats
    "url": null                    // optional: a fixed non-HuggingFace URL
  }
}
```

Slots by kind:

| Kind | Slots |
| --- | --- |
| `image`, `video` | `checkpoint`, `vae`, `clip`, `lora` |
| `llm` | `weights`, `aux` (mmproj) |
| `audio` | `weights`, `aux` (vocoder, tokenizer, speaker embeddings) |

Anything else may be supplied at install time as `other:<directory>`, which
creates that directory inside the bundle — but a catalogue entry should use a
known slot, since the generators only look in those.

## What the server filters out

The file list for a component is fetched live from HuggingFace rather than
being baked into the catalogue, so a new quantization upload is never a
catalogue edit. Three classes of file are excluded, because each would install
as a bundle that *looks* complete and then misbehaves:

- **Multi-part shards** (`model-00001-of-00003.gguf`). The downloader fetches
  one file per component, so a lone shard is a silently truncated model and
  nothing downstream detects a partial file.
- **Vision projectors** (`mmproj-*`) outside the `llm_vision` role. Loaded as
  weights, they produce a working server that generates nonsense.
- **Speculative-decoding draft weights** (`mtp-`, `dflash-`, `eagle3-`,
  `*-draft`). These load fine and generate visibly worse output — the worst
  kind of wrong, because nothing errors.

A model whose only available quantizations are sharded is therefore not a fit
for this app today, and should not be listed.

## Example

```jsonc
{
  "version": 1,
  "updatedAt": "2026-08-15T00:00:00Z",
  "models": [
    {
      "id": "qwen3-8b",
      "kind": "llm",
      "name": "Qwen3 8B",
      "description": "General-purpose instruct model with tool calling.",
      "tags": ["instruct", "tools"],
      "params": "8B",
      "components": [
        {
          "slot": "weights",
          "label": "Weights",
          "required": true,
          "quantizable": true,
          "source": { "repo": "ggml-org/Qwen3-8B-GGUF", "extensions": [".gguf"] }
        }
      ]
    },
    {
      "id": "chatterbox",
      "kind": "audio",
      "name": "Chatterbox TTS",
      "family": "chatterbox",
      "task": "tts",
      "tags": ["voice-cloning"],
      "components": [
        {
          "slot": "weights",
          "label": "Model",
          "required": true,
          "quantizable": true,
          "source": { "repo": "audio-cpp/audio.cpp-gguf", "path": "chatterbox" }
        }
      ]
    }
  ]
}
```

## Authoring notes

- **Verify repo ids against the real HuggingFace API**, not from memory. A
  wrong id produces an install that fails at download time, after the user has
  already chosen a quantization.
- **`ggml-org` publishing a GGUF conversion** is the strongest available signal
  that mainline llama.cpp actually supports an architecture, since it is the
  project's own account.
- **Audio `family` and `task` must match audio.cpp's own identifiers**
  (`model_specs/<family>.json`), confirmed from its source. A bundle whose
  manifest declares neither is skipped when the server registry is generated,
  and the model silently never appears.

## Speech-to-video

A video model that conditions on speech declares `"capabilities": ["s2v"]`.
Nothing is inferred: whether a checkpoint accepts audio is a property of how it
was trained, and guessing from the filename would offer the UI's **Speech to
Video** tab a model that silently ignores the audio it is handed.

The optional `s2v` block tunes how a run is chunked. Every field has a default,
so a model that matches Wan's window needs only the capability flag.

```jsonc
"s2v": {
  "audio_flag": "--ref-audio",  // the backend flag the WAV is passed under
  "frames_per_chunk": 81,       // frames the model emits per window
  "chunk_seconds": 5,           // seconds of speech per window
  "overlap_seconds": 0.5,       // replayed from the previous window, to blend seams
  "sample_rate": 16000,         // resample chunks to what the audio encoder expects
  "chain_frames": true,         // seed each window with the last frame of the previous
  "chain_flag": "-i",           // the flag that chained frame is passed under
  "audio_encoder_flag": null,   // flag a separate speech encoder is passed under, if any
  "frame_grid": { "stride": 17, "offset": 5 }  // round frame counts to stride*k + offset
}
```

`chain_flag` exists because the same conceptual input needs a different flag per
model: MiniMax-H3's Ref2VA rejects `--init-img` outright when reference
conditioning is in play, so its chained frame goes to `-r` instead.

`frame_grid` is not cosmetic. A model that rounds its frame count up on its own
(MiniMax-H3 aligns to 17k+5) hands back a segment slightly longer than the audio
it covers, and that error compounds at every seam. Declaring the grid lets the
rounding happen before the stitch, which is the only place that knows the real
segment length.

`audio_flag` is the field that makes this model-agnostic, and it is the reason
adding a second S2V model is a catalogue edit rather than a release. sd-cli
exposes MiniMax-H3's audio input as `--ref-audio`; a future Wan S2V may land
under another name, and only this line has to change.

Audio longer than one window is sliced, generated a window at a time and
stitched — see [ARCHITECTURE.md](ARCHITECTURE.md) for why that is unavoidable
rather than a shortcut. Long-audio runs therefore need `ffmpeg` on `PATH` (or
`FFMPEG_PATH` set); audio short enough for a single window does not.

### MiniMax-H3 Ref2VA

The one audio-conditioned video model `stable-diffusion.cpp` can run today, and
therefore the one that proves this path end to end. Published as
`minimax-h3-ref2va`.

Worth being precise about what it does: MiniMax-H3 **jointly generates video and
its own stereo soundtrack**, and `--ref-audio` is a *reference* that conditions
the result. It is not lip-sync — a Wan-style S2V model driving a speaker's mouth
from a speech track is a different thing, and that is the gap Wan 2.2 S2V below
is meant to fill. The `s2v` capability covers both because the pipeline is the
same: audio in, chunked, video out.

It needs four components, not three — the audio VAE is separate, and without it
the model still runs but the video comes out silent. Both VAEs live in the `vae`
slot and are told apart by filename (`audio_vae` vs `video_vae`), the same way
Wan 2.2's two experts are told apart in `checkpoint`.

Two constraints from the upstream docs are encoded in its entry: frames align to
a 17k+5 grid, and fps is forced to 24 regardless of what is requested. The
`extraArgs` (`--diffusion-fa --offload-to-cpu --rng cpu`) are what every
upstream example uses — a 32B text encoder alongside the DiT does not fit a
single consumer card without them.

### Wan 2.2 S2V

(Wan 2.2 *T2V* and *I2V* A14B do split denoising across two experts. Both go in
`checkpoint/`, and the high-noise one is recognised by its filename or named
explicitly through the manifest's `components.checkpoint_high_noise`. S2V does
not work that way.)

```jsonc
{
  "id": "wan2.2-s2v-14b",
  "kind": "video",
  "name": "Wan 2.2 S2V 14B",
  "description": "Speech-to-video. Generates a talking subject from an audio track and a reference image.",
  "reference": "https://huggingface.co/Wan-AI/Wan2.2-S2V-14B",
  "tags": ["s2v", "speech", "wan"],
  "loadMode": "diffusion-model",
  "mode": "video",
  "capabilities": ["s2v"],
  "s2v": { "audio_flag": "--ref-audio", "frames_per_chunk": 81, "chunk_seconds": 5, "overlap_seconds": 0.5, "sample_rate": 16000 },
  "defaults": { "steps": 20, "cfg_scale": 3.5, "width": 640, "height": 640, "fps": 16, "flow_shift": 5 },
  "components": [
    {
      "slot": "checkpoint",
      "label": "Diffusion model (low noise)",
      "required": true,
      "quantizable": true,
      "source": { "repo": "QuantStack/Wan2.2-S2V-14B-GGUF", "extensions": [".gguf"] }
    },
    {
      "slot": "vae",
      "label": "VAE",
      "required": true,
      "source": { "repo": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "match": "wan2.1_vae" }
    },
    {
      "slot": "clip",
      "role": "t5xxl",
      "label": "UMT5-XXL text encoder",
      "required": true,
      "quantizable": true,
      "source": { "repo": "city96/umt5-xxl-encoder-gguf", "match": "umt5" }
    }
  ]
}
```

Published as `wan2.2-s2v-14b`. It is driven through sd-cli exactly like the
other Wan models — `-M vid_gen`, `--diffusion-model`, `--vae`, `--t5xxl` — with
the speech chunk added as `--ref-audio`:

```sh
sd-cli -M vid_gen \
  --diffusion-model .../Wan2.2-S2V-14B-Q4_K_M.gguf \
  --vae .../wan_2.1_vae.safetensors \
  --t5xxl .../umt5_xxl_fp8_e4m3fn_scaled.safetensors \
  --ref-audio .../chunk-0000.wav \
  -o .../segment-0000.webm \
  -p "Close-up portrait of a person talking, high detail, moving lips" \
  --steps 20 --cfg-scale 4.5 -W 832 -H 480 --sampling-method euler \
  --video-frames 81 --flow-shift 5 --fps 16 --diffusion-fa --offload-to-cpu
```

Chunks after the first add `-i <last frame of the previous segment>`.

Two things to know before the first run on a GPU host:

- **sd-cli has no Wan S2V implementation as of this writing.** Upstream
  `docs/wan.md` covers T2V, I2V and FLF2V, and `--ref-audio` is registered for
  MiniMax-H3's Ref2VA. Whether it reaches Wan's audio conditioning is the thing
  the first run answers. If sd-cli rejects the flag or ignores the audio, the
  fix is `s2v.audio_flag` here, not a code change.
- **The wav2vec2 speech encoder is downloaded but not passed.** Wan 2.2 S2V
  needs it, and sd-cli registers no flag that takes it. It installs into `aux/`
  so the weights are already local; set `s2v.audio_encoder_flag` once the flag
  exists and it is emitted automatically.

Unlike Wan 2.2 T2V/I2V A14B, S2V is a **single** 14B model — there is no
high-noise expert, so `--high-noise-diffusion-model` does not appear.
