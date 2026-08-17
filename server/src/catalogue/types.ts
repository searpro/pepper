import { z } from 'zod';

/**
 * The remote catalogue schema (requirement 7).
 *
 * "Currently the manifest is hardcoded. This needs to change and it should be
 * a remote json driven manifest. A separate github repo will keep the manifest
 * file pepper-catalogue.json which will contain all the models available for
 * download. One manifest for all types of models (text/image/audio/video)."
 *
 * So there is deliberately no curated model list in this codebase — not even a
 * fallback one. Shipping models in the source is what made sd-api's catalogue
 * a release-blocking edit every time a new checkpoint appeared, and a
 * hardcoded fallback would quietly become the real catalogue the moment the
 * remote fetch had a bad day.
 *
 * The schema is permissive about what it does not know: unrecognised fields
 * pass through untouched, so the catalogue repo can start publishing a new
 * attribute before the server understands it, and only the server's *use* of
 * that attribute needs a release.
 */

export const catalogueSourceSchema = z.object({
  /** HuggingFace repo id, "owner/name". */
  repo: z.string(),
  /** Sub-folder within the repo, e.g. "split_files/diffusion_models". */
  path: z.string().optional(),
  /**
   * Case-insensitive substring the filename must contain, to disambiguate a
   * repo holding several unrelated files ("ae" for the VAE, "clip_l" for the
   * CLIP-L encoder).
   */
  match: z.string().optional(),
  /** Filename extensions to offer. Defaults to the weight formats. */
  extensions: z.array(z.string()).optional(),
  /** A direct URL, for anything not hosted on HuggingFace. */
  url: z.string().url().optional(),
  /**
   * Pull the whole `repo`/`path` tree as one unit (huggingface-cli/`hf_transfer`
   * snapshot download) instead of the usual single-file pick. vLLM models are
   * typically multi-file HF repos (config.json, tokenizer, sharded
   * safetensors) with no single weight file to offer a quant picker for.
   */
  snapshot: z.boolean().optional(),
});

export type CatalogueSource = z.infer<typeof catalogueSourceSchema>;

export const catalogueComponentSchema = z.object({
  /** Bundle sub-directory this component installs into. */
  slot: z.string(),
  /** Text-encoder role, for `clip/` components. */
  role: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().default(false),
  /** Whether the user picks between quantizations. */
  quantizable: z.boolean().default(false),
  source: catalogueSourceSchema,
});

export type CatalogueComponent = z.infer<typeof catalogueComponentSchema>;

export const catalogueModelSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['image', 'video', 'audio', 'llm']),
    name: z.string(),
    description: z.string().optional(),
    /** Link to upstream documentation. */
    reference: z.string().optional(),
    /** Free-form labels the UI filters on ("fast", "edit", "vision", …). */
    tags: z.array(z.string()).default([]),
    /**
     * Which backend serves this model. Undefined means "the .cpp backend for
     * `kind`" (sd-cpp for image/video, llama.cpp for llm, audio.cpp for
     * audio) — the historical default. Set to `vllm` to tag a catalogue entry
     * as vLLM/vLLM-Omni-only: those entries carry `huggingfaceId` instead of
     * (or alongside) `components[].source` weight URLs.
     */
    backend: z.enum(['sdcpp', 'llamacpp', 'audiocpp', 'vllm']).optional(),
    /** HuggingFace repo id vLLM loads directly, e.g. "Wan-AI/Wan2.2-S2V-14B". */
    huggingfaceId: z.string().optional(),
    /** vLLM-Omni pipeline class, e.g. "WanS2VPipeline". Only meaningful when `backend: 'vllm'`. */
    vllmPipelineClass: z.string().optional(),

    // --- image / video ---
    loadMode: z.enum(['model', 'diffusion-model']).optional(),
    mode: z.enum(['image', 'video']).optional(),
    /** Edit model: expects one or more reference images at generation time. */
    edit: z.boolean().optional(),
    /**
     * Extra abilities, e.g. `s2v` for a speech-conditioned video model. Copied
     * into the installed bundle's manifest, which is what the generator and
     * the UI's Speech to Video tab actually read.
     */
    capabilities: z.array(z.string()).optional(),
    /** Speech-to-video wiring, mirroring the bundle manifest's `s2v` block. */
    s2v: z.record(z.unknown()).optional(),
    defaults: z.record(z.unknown()).optional(),
    extraArgs: z.array(z.string()).optional(),

    // --- llm ---
    /** Total parameter count, which drives download size and memory footprint. */
    params: z.string().optional(),
    /** Active parameters for MoE models — what actually drives inference cost. */
    activeParams: z.string().optional(),
    vision: z.boolean().optional(),

    // --- audio ---
    /** audio.cpp family, matching its `model_specs/<family>.json`. */
    family: z.string().optional(),
    /** tts | asr | voice-design | voice-conversion */
    task: z.string().optional(),
    audioMode: z.string().optional(),

    components: z.array(catalogueComponentSchema).min(1),
  })
  .passthrough();

export type CatalogueModel = z.infer<typeof catalogueModelSchema>;

export const catalogueSchema = z.object({
  /** Bumped by the catalogue repo when the shape changes incompatibly. */
  version: z.number().default(1),
  updatedAt: z.string().optional(),
  models: z.array(catalogueModelSchema),
});

export type Catalogue = z.infer<typeof catalogueSchema>;

/** One downloadable file option for a component, as offered to the user. */
export interface ComponentFileOption {
  /** Path within the source repo. */
  path: string;
  filename: string;
  size: number;
  /** Quantization label, e.g. `Q4_K_M`, when one is detectable. */
  quant?: string;
  url: string;
}
