# pepper-catalogue

The model catalogue for [pepper](https://github.com/searpro/pepper): one JSON
manifest listing every model available for download, across image, video, audio
and text.

Pepper fetches `pepper-catalogue.json` at startup, caches a copy on its data
volume, and serves it to the Models window in the UI. Adding a model is a pull
request here — no pepper release, no redeploy.

## Files

| File | Purpose |
| --- | --- |
| `pepper-catalogue.json` | The catalogue itself. |
| `validate.mjs` | Structure and live-source validation. No dependencies. |

## Validating a change

```bash
node validate.mjs          # structure only — offline, instant
node validate.mjs --live   # also resolves every source against HuggingFace
```

Run `--live` before merging. A structurally perfect entry pointing at a repo
that was renamed, gated, or never existed produces an install that fails *after*
the user has picked a quantization — the worst moment to find out. CI runs it on
push and weekly, because these repos change underneath us.

## Adding a model

A model entry says what the model *is* and which repositories its parts come
from. It does **not** list individual files: pepper resolves those live from
HuggingFace at install time, so a new quantization upload is never a catalogue
edit.

```jsonc
{
  "id": "qwen3-8b",          // unique per kind; the default bundle directory name
  "kind": "llm",             // image | video | audio | llm
  "name": "Qwen3 8B",
  "description": "One or two sentences. Say what it is good at and what it costs.",
  "reference": "https://huggingface.co/Qwen/Qwen3-8B",
  "tags": ["instruct", "tools"],
  "params": "8B",
  "components": [
    {
      "slot": "weights",
      "label": "Weights",
      "required": true,      // pre-selected in the install dialog
      "quantizable": true,   // user picks between quantizations
      "source": { "repo": "ggml-org/Qwen3-8B-GGUF", "extensions": [".gguf"] }
    }
  ]
}
```

Component slots by kind:

| Kind | Slots |
| --- | --- |
| `image`, `video` | `checkpoint`, `vae`, `clip` (with a `role`), `lora` |
| `llm` | `weights`, `aux` (vision projector) |
| `audio` | `weights`, `aux` (vocoder, tokenizer, speaker embeddings) |

`clip` components should carry an explicit `role` — `clip_l`, `clip_g`,
`t5xxl`, `clip_vision`, `llm`, `llm_vision` — since that decides which flag the
file is passed under, and a text encoder loaded under the wrong flag produces
garbage rather than an error.

Narrow a source with `path` (a sub-folder) and `match` (a case-insensitive
substring of the filename) when a repo holds several unrelated files:

```jsonc
"source": {
  "repo": "Comfy-Org/Wan_2.1_ComfyUI_repackaged",
  "path": "split_files/text_encoders",
  "match": "umt5",
  "extensions": [".safetensors"]
}
```

### Kind-specific requirements

- **image / video** — set `loadMode`: `"model"` for an all-in-one checkpoint,
  `"diffusion-model"` when the VAE and encoders are separate components. Video
  models must set `"mode": "video"`, or they generate a single frame.
- **audio** — `family` and `task` are mandatory. `family` must match audio.cpp's
  own `model_specs/<family>.json` identifier exactly (e.g. `chatterbox`,
  `qwen3_tts`, `parakeet_tdt`); pepper writes both into the installed bundle's
  manifest, and audio.cpp cannot register a model without them.
- **llm** — `params` drives the size and memory hints in the UI. Set `vision`
  and add an `aux` component with `"match": "mmproj"` for multimodal models.

## What pepper filters out

Three classes of file are excluded from every listing, because each installs as
a bundle that *looks* complete and then misbehaves:

- **Multi-part shards** (`model-00001-of-00003.gguf`) — the downloader fetches
  one file per component, so a lone shard is a silently truncated model.
- **Vision projectors** (`mmproj-*`) in components that did not ask for one.
- **Speculative-decoding draft weights** (`mtp-`, `dflash-`, `dspark-`,
  `eagle3-`, `*-draft`) — these load fine and generate visibly worse output,
  which nothing errors on.

A model whose only quantizations are sharded is therefore not a fit today and
should not be listed.

## Authoring notes

- **Verify repo ids against the real HuggingFace API**, never from memory. The
  `--live` validator does this for you.
- **`ggml-org` publishing a GGUF conversion** is the strongest available signal
  that mainline llama.cpp supports an architecture — it is the project's own
  account.
- **Prefer ungated repositories.** A gated one needs every user to accept a
  licence and configure `HF_TOKEN` before the entry works at all.
- **Keep descriptions honest about cost.** "14B video model, minutes per clip"
  saves more support time than a list of adjectives.

## Current contents

16 models, all verified against live HuggingFace listings:

- **Image** — FLUX.1 schnell (GGUF and single-file), Qwen-Image, SDXL 1.0, SD 1.5
- **Video** — Wan 2.1 T2V 14B, Wan 2.1 I2V 14B 480p
- **Text** — Qwen3 8B, Gemma 3 4B, Qwen2.5-VL 7B, SmolLM3 3B
- **Audio** — Chatterbox (cloning), Qwen3-TTS VoiceDesign, VibeVoice 1.5B
  (long-form), Qwen3-ASR 0.6B, Parakeet-TDT 0.6B v3
