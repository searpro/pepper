import type { BackendId } from '../config.js';
import type { BackendArgSpec } from '../core/backends/args.js';

export * from '../core/backends/args.js';
import { LLAMACPP_ARGS } from '../core/llama.js';
export { LLAMACPP_ARGS };

/**
 * Pepper's backend argument tables. The mechanism — locked values, user
 * overrides, rendering to argv — is shared (`core/backends/args.ts`); these
 * are the flags and sd-api's seeded values for each of Pepper's backends.
 */

/**
 * audio.cpp. Unlike llama.cpp it has no directory-scan mode: it loads an
 * explicit JSON model registry via `--config`, which the app generates (see
 * `src/backends/audio-config.ts`).
 */
export const AUDIOCPP_ARGS: BackendArgSpec = {
  backend: 'audiocpp',
  label: 'audio.cpp (speech & transcription)',
  kind: 'server',
  args: [
    {
      key: 'config',
      flag: '--config',
      label: 'Model registry',
      description: 'Generated from the installed audio bundles. Managed by the app.',
      type: 'string',
      locked: true,
    },
    {
      key: 'host',
      flag: '--host',
      label: 'Bind address',
      type: 'string',
      defaultValue: '127.0.0.1',
      locked: true,
    },
    { key: 'port', flag: '--port', label: 'Port', type: 'number', locked: true },
    {
      // audiocpp_server defaults `--backend` to cuda, so every non-CUDA host
      // fails at startup ("CUDA backend requested but it is not registered in
      // this build") even when the correct Metal/Vulkan asset was installed.
      // The value is derived from ACCEL rather than left to the binary.
      key: 'backend',
      flag: '--backend',
      label: 'Compute backend',
      description: 'Derived from ACCEL. Must match the installed build.',
      type: 'string',
      locked: true,
    },
    {
      key: 'threads',
      flag: '-t',
      label: 'Threads',
      description: 'CPU threads for inference. Empty uses the backend default.',
      type: 'number',
      defaultValue: null,
      min: 1,
      max: 256,
    },
  ],
};

/**
 * stable-diffusion.cpp. Spawned fresh per generation, so most of its argv is
 * per-request (prompt, model, size) and built by the image service. Only the
 * process-wide options that apply to *every* run are configurable here.
 */
export const SDCPP_ARGS: BackendArgSpec = {
  backend: 'sdcpp',
  label: 'stable-diffusion.cpp (image & video)',
  kind: 'cli',
  args: [
    {
      key: 'threads',
      flag: '-t',
      label: 'Threads',
      description: 'CPU threads. Empty lets sd-cli choose based on the host.',
      type: 'number',
      defaultValue: null,
      min: 1,
      max: 256,
    },
    {
      key: 'diffusion_fa',
      flag: '--diffusion-fa',
      label: 'Flash attention (diffusion)',
      description: 'Lower memory use on supported GPUs.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'vae_tiling',
      flag: '--vae-tiling',
      label: 'VAE tiling',
      description: 'Decode large images in tiles. Slower, but avoids VAE out-of-memory.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'offload_to_cpu',
      flag: '--offload-to-cpu',
      label: 'Offload to CPU',
      description: 'Keep idle weights in system RAM. Helps on tight VRAM.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'verbose',
      flag: '-v',
      label: 'Verbose output',
      description: 'More detailed logs from the generator, streamed to the Log viewer.',
      type: 'boolean',
      defaultValue: false,
    },
  ],
};

/**
 * Experimental Python backend (requirement 5's forward-looking item). Nothing
 * generates against it yet; the argument surface exists so the install and
 * supervision paths are exercised by the same code as the others.
 */
export const PYTHON_ARGS: BackendArgSpec = {
  backend: 'python',
  label: 'Python backend (experimental)',
  kind: 'server',
  args: [
    {
      key: 'listen',
      flag: '--listen',
      label: 'Bind address',
      type: 'string',
      defaultValue: '127.0.0.1',
      locked: true,
    },
    { key: 'port', flag: '--port', label: 'Port', type: 'number', locked: true },
    {
      key: 'cpu',
      flag: '--cpu',
      label: 'Force CPU',
      description: 'Run without CUDA even when a GPU is present.',
      type: 'boolean',
      defaultValue: false,
    },
  ],
};

/**
 * vLLM / vLLM-Omni. Unlike llama.cpp's directory-scan router, vLLM serves
 * exactly one model per process and cannot hot-swap — switching the active
 * model means killing and respawning with a different `--model`/pipeline
 * class, so those two are `locked` and computed at spawn time from the
 * currently-selected vLLM bundle (see the `vllm` prepare hook), the same way
 * audio.cpp's `--config` is computed from its generated registry.
 *
 * `--omni` is always passed: pepper only spawns the `vllm-omni` entrypoint,
 * never plain vLLM, so there is no reason to expose it as a toggle.
 *
 * Flags and defaults mirror the documented Wan2.2-S2V-14B invocation
 * (https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/speech_to_video/):
 *
 *   VLLM_WORKER_MULTIPROC_METHOD=spawn vllm serve <model> --omni \
 *     --model-class-name WanS2VPipeline --tensor-parallel-size 2 \
 *     --flow-shift 3.0 --vae-use-slicing --vae-use-tiling \
 *     --cache-backend cache_dit --port 8091
 */
export const VLLM_ARGS: BackendArgSpec = {
  backend: 'vllm',
  label: 'vLLM-Omni (image / audio / video / text)',
  kind: 'server',
  args: [
    {
      key: 'model',
      flag: '--model',
      label: 'Model (HuggingFace id or local path)',
      description: 'Computed from the selected vLLM model. Managed by the app.',
      type: 'string',
      locked: true,
    },
    {
      key: 'served_model_name',
      flag: '--served-model-name',
      label: 'Served model name',
      description: 'The name clients pass as "model" in requests. Managed by the app.',
      type: 'string',
      locked: true,
    },
    {
      key: 'model_class_name',
      flag: '--model-class-name',
      label: 'vLLM-Omni pipeline class',
      description: 'e.g. WanS2VPipeline. Computed from the selected model. Managed by the app.',
      type: 'string',
      locked: true,
    },
    {
      key: 'omni',
      flag: '--omni',
      label: 'Omni mode',
      description: 'Always on — pepper only runs the vllm-omni entrypoint.',
      type: 'boolean',
      defaultValue: true,
      locked: true,
    },
    {
      key: 'host',
      flag: '--host',
      label: 'Bind address',
      description: 'Loopback only — the app is the public surface.',
      type: 'string',
      defaultValue: '127.0.0.1',
      locked: true,
    },
    { key: 'port', flag: '--port', label: 'Port', type: 'number', locked: true },
    {
      key: 'tensor_parallel_size',
      flag: '--tensor-parallel-size',
      label: 'Tensor parallel size',
      description: 'GPUs to shard the model across. Defaults to the detected GPU count.',
      type: 'number',
      defaultValue: 1,
      min: 1,
      max: 32,
    },
    {
      key: 'gpu_memory_utilization',
      flag: '--gpu-memory-utilization',
      label: 'GPU memory utilization',
      description: 'Fraction of each GPU\'s memory vLLM is allowed to reserve.',
      type: 'number',
      defaultValue: 0.9,
      min: 0.1,
      max: 1,
    },
    {
      key: 'max_model_len',
      flag: '--max-model-len',
      label: 'Max model length',
      description: 'Context/sequence length ceiling. Empty lets vLLM decide.',
      type: 'number',
      defaultValue: null,
      min: 1,
    },
    {
      key: 'flow_shift',
      flag: '--flow-shift',
      label: 'Flow shift',
      description: 'Diffusion model-specific parameter (Wan family default: 3.0).',
      type: 'number',
      defaultValue: null,
    },
    {
      key: 'vae_use_slicing',
      flag: '--vae-use-slicing',
      label: 'VAE slicing',
      description: 'Memory optimization for large diffusion/video models.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'vae_use_tiling',
      flag: '--vae-use-tiling',
      label: 'VAE tiling',
      description: 'Memory optimization for large diffusion/video models.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'cache_backend',
      flag: '--cache-backend',
      label: 'Cache backend',
      description: '"cache_dit" roughly doubles throughput on cached diffusion steps.',
      type: 'string',
      defaultValue: null,
    },
  ],
};

export const ARG_SPECS: Record<BackendId, BackendArgSpec> = {
  sdcpp: SDCPP_ARGS,
  llamacpp: LLAMACPP_ARGS,
  audiocpp: AUDIOCPP_ARGS,
  python: PYTHON_ARGS,
  vllm: VLLM_ARGS,
};

