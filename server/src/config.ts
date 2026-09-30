import { join } from 'node:path';
import {
  bool,
  loadCoreConfig,
  num,
  path,
  positiveNum,
  repo,
  type CoreConfig,
} from './core/config.js';

export { publicConfig, type Accel, type LogLevel } from './core/config.js';

/**
 * Pepper's configuration: the shared `CoreConfig` plus what its own engines
 * (sd-cli, llama.cpp, audio.cpp, the Python runners, vLLM) need. See
 * `core/config.ts` for why everything is environment-driven.
 */

/** Backends the process/binary managers know how to install and supervise. */
export const BACKENDS = ['sdcpp', 'llamacpp', 'audiocpp', 'python', 'vllm'] as const;
export type BackendId = (typeof BACKENDS)[number];

export interface Config extends CoreConfig {
  /**
   * Directory of ESRGAN upscaler weights (`*.safetensors`, `*.pth`, `*.gguf`).
   * Defaults to `DATA_DIR/models/upscale`. The native scale is read from the
   * file name (`RealESRGAN_x4plus` is 4×), which is how every published
   * ESRGAN checkpoint is named.
   */
  upscaleModelsDir: string;

  /** "owner/repo" whose *latest* release is installed, per backend. */
  releaseRepos: Record<BackendId, string>;

  /** Hard ceiling on one sd-cli image generation. */
  sdcppTimeoutMs: number;
  /**
   * Hard ceiling on one sd-cli *video* generation. Video runs an order of
   * magnitude longer than an image, so it gets its own budget rather than
   * forcing `sdcppTimeoutMs` up for everything.
   */
  sdcppVideoTimeoutMs: number;
  /** Ceiling on one proxied audio request. */
  audiocppTimeoutMs: number;
  /** Ceiling on one proxied LLM completion. */
  llamacppTimeoutMs: number;

  /** Loopback ports the persistent backends listen on. Never public. */
  llamacppPort: number;
  audiocppPort: number;
  pythonPort: number;
  /**
   * Run Python jobs with this interpreter instead of the managed runtime —
   * for development against an existing venv that already has torch. The
   * managed runtime (and its runner environment) is used when unset.
   */
  pythonExecutable?: string;
  /**
   * Where the managed Python runtime, its venvs and cloned packages live.
   * Defaults to `DATA_DIR/bin/python`. The Docker image points it at a
   * directory baked in at build time: installing torch onto a network volume
   * at first use took over twenty minutes on RunPod, against none when the
   * environment ships in the image.
   */
  pythonDir?: string;
  /**
   * Stop the other resident backends (llama.cpp, audio.cpp, vLLM) before a
   * Python video job. On unified memory a video model and a resident LLM do
   * not fit together; the stopped backends restart on their next request.
   */
  pythonExclusiveMemory: boolean;
  vllmPort: number;
}

const DEFAULT_RELEASE_REPOS: Record<BackendId, string> = {
  sdcpp: 'searpro/stable-diffusion.cpp',
  // Upstream's Linux builds moved to Ubuntu 24.04 (glibc 2.38) and do not
  // start on 22.04 hosts (Kaggle, the vLLM-Omni base image); the fork builds
  // upstream tags on 22.04 with the CUDA runtime bundled.
  llamacpp: 'searpro/llama.cpp',
  audiocpp: 'searpro/audio.cpp',
  // No fork exists yet — the Python backend installs a runtime rather than a
  // release archive, and this is the hook for wherever that eventually lives.
  python: 'comfyanonymous/ComfyUI',
  // Unused: vLLM is baked into the production image (see Dockerfile.vllm) rather
  // than installed from a GitHub release. Kept only so `Record<BackendId, string>`
  // stays total; `BackendManager` never reads it for this backend.
  vllm: 'vllm-project/vllm-omni',
};

/**
 * Timeout defaults carried over from sd-api's working configuration, so a
 * deployment that sets none of these behaves exactly like the POC did.
 */
const DEFAULTS = {
  sdcppTimeoutMs: 600_000, // sd-api job_timeout_ms
  sdcppVideoTimeoutMs: 3_600_000, // sd-api video_job_timeout_ms
  audiocppTimeoutMs: 300_000, // sd-api audio_request_timeout_ms
  llamacppTimeoutMs: 300_000, // sd-api llm_request_timeout_ms
  llamacppPort: 8090,
  audiocppPort: 8091,
  pythonPort: 8092,
  vllmPort: 8093,
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const core = loadCoreConfig(env, {
    outputDirName: 'pepper-outputs',
    catalogueUrl: 'https://raw.githubusercontent.com/searpro/pepper-catalogue/main/pepper-catalogue.json',
  });

  return {
    ...core,
    upscaleModelsDir: path(env.UPSCALE_MODELS_DIR?.trim() || join(core.dataDir, 'models', 'upscale')),

    releaseRepos: {
      sdcpp: repo('SDCPP_RELEASE_REPO', env.SDCPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.sdcpp),
      llamacpp: repo('LLAMACPP_RELEASE_REPO', env.LLAMACPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.llamacpp),
      audiocpp: repo('AUDIOCPP_RELEASE_REPO', env.AUDIOCPP_RELEASE_REPO, DEFAULT_RELEASE_REPOS.audiocpp),
      python: repo('PYTHON_RELEASE_REPO', env.PYTHON_RELEASE_REPO, DEFAULT_RELEASE_REPOS.python),
      vllm: DEFAULT_RELEASE_REPOS.vllm,
    },

    sdcppTimeoutMs: positiveNum('SDCPP_TIMEOUT', env.SDCPP_TIMEOUT, DEFAULTS.sdcppTimeoutMs),
    sdcppVideoTimeoutMs: positiveNum(
      'SDCPP_VIDEO_TIMEOUT',
      env.SDCPP_VIDEO_TIMEOUT,
      DEFAULTS.sdcppVideoTimeoutMs,
    ),
    audiocppTimeoutMs: num('AUDIOCPP_TIMEOUT', env.AUDIOCPP_TIMEOUT, DEFAULTS.audiocppTimeoutMs),
    llamacppTimeoutMs: num('LLAMACPP_TIMEOUT', env.LLAMACPP_TIMEOUT, DEFAULTS.llamacppTimeoutMs),

    llamacppPort: positiveNum('LLAMACPP_PORT', env.LLAMACPP_PORT, DEFAULTS.llamacppPort),
    audiocppPort: positiveNum('AUDIOCPP_PORT', env.AUDIOCPP_PORT, DEFAULTS.audiocppPort),
    pythonPort: positiveNum('PYTHON_PORT', env.PYTHON_PORT, DEFAULTS.pythonPort),
    pythonExecutable: env.PYTHON_EXECUTABLE?.trim() ? path(env.PYTHON_EXECUTABLE.trim()) : undefined,
    pythonDir: env.PYTHON_DIR?.trim() ? path(env.PYTHON_DIR.trim()) : undefined,
    pythonExclusiveMemory: bool('PYTHON_EXCLUSIVE_MEMORY', env.PYTHON_EXCLUSIVE_MEMORY, true),
    vllmPort: positiveNum('VLLM_PORT', env.VLLM_PORT, DEFAULTS.vllmPort),
  };
}
