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

`loadMode`, `mode`, `defaults`, `extraArgs`, `family`, `task` and `audioMode`
are written into the installed bundle's `model.json` at install time. That is
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
