import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { BackendId } from '../config.js';
import type { BackendManager } from '../backends/manager.js';
import type { JobContext, JobExecutor, JobManager } from '../jobs/manager.js';
import type { ModelManager } from '../models/manager.js';
import { bundleDir, safeResolve, type Paths } from '../paths.js';
import type { GenerateParams } from '../schemas/generate.js';
import type { AudioService } from '../services/audio-gen.js';
import type { ImageService } from '../services/image.js';
import type { PythonVideoService } from '../services/python-video.js';
import type { TextService } from '../services/text-gen.js';
import type { UpscaleService } from '../services/upscale.js';
import { uniqueOutputName } from '../util/files.js';
import type { Engine, ReleaseReason } from './engine.js';

/**
 * Pepper's engines: sd-cli with the one-shot Python runners (image and video),
 * audio.cpp (speech and music), llama.cpp (text) and vLLM (a proxied server
 * with no job kind of its own).
 *
 * Image and video share an executor because they share a generator — the
 * bundle's mode is what decides which one a run produces — and the Python
 * runners sit behind the same executor because a bundle's `backend` decides
 * which of the two runs it, not the job kind.
 */

export interface PepperEngineDeps {
  jobs: JobManager;
  images: ImageService;
  upscaler: UpscaleService;
  pythonVideo: PythonVideoService;
  models: ModelManager;
  speech: AudioService;
  text: TextService;
  backends: BackendManager;
  paths: Paths;
}

/** An engine backed by one supervised server process: resident while it runs, released by stopping it. */
function serverEngine(
  backends: BackendManager,
  backend: BackendId,
  label: string,
  executors: ReturnType<Engine['executors']>,
): Engine {
  const running = () => {
    const proc = backends.get(backend);
    return Boolean(proc && proc.status !== 'stopped' && proc.status !== 'failed');
  };
  return {
    id: backend,
    label,
    executors: () => executors,
    resident: running,
    release: async (_reason: ReleaseReason) => {
      if (!running()) return;
      await backends.get(backend)?.stop();
    },
  };
}

export function createPepperEngines(deps: PepperEngineDeps): Engine[] {
  const { jobs, images, upscaler, pythonVideo, models, speech, paths, backends } = deps;
  const textService = deps.text;

  const generate: JobExecutor = async (context) => {
    // Upscales ride the image queue: they hold the same GPU, show up in the
    // same job list, and produce an image output like any other.
    if (context.job.params.task === 'upscale') return runUpscale(context);

    // Bundles served by the Python backend run through Pepper's own runners
    // (server/python/pepper_runner); everything else is sd-cli.
    const params = context.job.params as GenerateParams;
    const bundle = await models.find(params.model, ['image', 'video']).catch(() => null);
    if (bundle?.manifest?.backend === 'python') {
      const run = await pythonVideo.generate({
        bundle,
        params,
        signal: context.signal,
        onProgress: context.onProgress,
        onLog: context.onLog,
      });
      return {
        video_path: run.outputPath,
        video_url: `/v1/outputs/${encodeURIComponent(run.outputName)}`,
        metadata: {
          kind: 'video',
          backend: 'python',
          runner: bundle.manifest.python_runner,
          prompt: run.params.prompt,
          negative_prompt: run.params.negative_prompt,
          model: run.params.model,
          steps: run.params.steps ?? bundle.manifest.defaults?.steps,
          cfg_scale: run.params.cfg_scale ?? bundle.manifest.defaults?.cfg_scale,
          seed: run.params.seed,
          init_image: run.params.init_image,
          audio: run.params.audio,
          ...run.runner,
          video_frames: run.runner.frames,
          duration_ms: run.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }

    const result = await images.generate({
      params: context.job.params as never,
      signal: context.signal,
      onProgress: context.onProgress,
      onLog: context.onLog,
    });

    const url = `/v1/outputs/${encodeURIComponent(result.outputName)}`;
    return {
      ...(result.kind === 'video'
        ? { video_path: result.outputPath, video_url: url }
        : { image_path: result.outputPath, image_url: url }),
      metadata: {
        kind: result.kind,
        prompt: result.params.prompt,
        model: result.params.model,
        checkpoint: result.params.checkpoint,
        steps: result.params.steps,
        cfg_scale: result.params.cfg_scale,
        width: result.params.width,
        height: result.params.height,
        seed: result.params.seed,
        sampler: result.params.sampler,
        scheduler: result.params.scheduler,
        // The upscaler's directory is local detail; the rest reproduces the pass.
        hires: result.hires ? { ...result.hires, upscalersDir: undefined } : undefined,
        video_frames: result.params.video_frames,
        flow_shift: result.params.flow_shift,
        fps: result.s2v?.fps ?? result.params.fps,
        // Only present on a speech-driven run. How many chunks it took is the
        // number that explains the runtime, so it belongs in the result rather
        // than only in the logs.
        audio_duration_s: result.s2v?.audioDurationSeconds,
        audio_chunks: result.s2v?.chunks,
        // Everything else needed to reproduce the image from the Media page.
        negative_prompt: result.params.negative_prompt,
        init_image: result.params.init_image,
        strength: result.params.init_image ? result.params.strength : undefined,
        ref_images: result.params.ref_images,
        img_cfg_scale: result.params.ref_images?.length ? result.params.img_cfg_scale : undefined,
        increase_ref_index: result.params.increase_ref_index,
        loras: result.params.loras,
        sigmas: result.params.sigmas,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  const runUpscale: JobExecutor = async (context) => {
    const params = context.job.params as {
      image: string;
      source?: 'output' | 'upload';
      scale?: 2 | 4;
      upscaler?: string;
      resolution?: number;
      quality?: 'best' | 'sharp' | 'fast';
    };
    const source = params.source ?? 'output';
    const inputPath = await upscaler.resolveSource(params.image, source);

    if (/\.(webm|mp4|mov|mkv|avi)$/i.test(params.image)) {
      const origin =
        source === 'output'
          ? ((jobs.findByOutput(params.image)?.result?.metadata as Record<string, unknown> | undefined) ?? {})
          : {};
      const video = await upscaler.upscaleVideo({
        inputPath,
        resolution: params.resolution ?? 1080,
        quality: params.quality ?? 'best',
        onProgress: context.onProgress,
        onLog: context.onLog,
        signal: context.signal,
      });
      return {
        video_path: video.outputPath,
        video_url: `/v1/outputs/${encodeURIComponent(video.outputName)}`,
        metadata: {
          ...origin,
          kind: 'video',
          task: 'upscale',
          source_video: params.image,
          resolution: video.resolution,
          upscaler: video.model,
          upscale_engine: 'seedvr2',
          duration_ms: video.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }
    if (params.scale === undefined) throw new Error('Image upscales need a scale (2 or 4)');
    const result = await upscaler.upscale({
      inputPath,
      scale: params.scale,
      model: params.upscaler,
      signal: context.signal,
      onProgress: context.onProgress,
      onLog: context.onLog,
    });

    // Carry the source image's generation settings forward, so an upscaled
    // image can still be reproduced or reused from the Media page.
    const origin =
      source === 'output'
        ? ((jobs.findByOutput(params.image)?.result?.metadata as Record<string, unknown> | undefined) ?? {})
        : {};

    return {
      image_path: result.outputPath,
      image_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
      metadata: {
        ...origin,
        kind: 'image',
        task: 'upscale',
        scale: result.scale,
        source_image: params.image,
        source_width: result.sourceWidth,
        source_height: result.sourceHeight,
        width: result.width,
        height: result.height,
        upscaler: result.model,
        upscale_engine: result.engine,
        upscale_architecture: result.architecture,
        upscale_method: result.method,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  const audio: JobExecutor = async (context) => {
    // Music rides the audio queue: same backend, same memory budget.
    if (context.job.params.task === 'music') {
      const musicParams = context.job.params as { model: string };
      const bundle = await models.find(musicParams.model, ['audio']).catch(() => null);
      const result =
        bundle?.manifest?.backend === 'python'
          ? await pythonMusic(pythonVideo, paths, bundle, context)
          : await speech.generateMusic({
              params: context.job.params as never,
              family: bundle?.manifest?.family,
              signal: context.signal,
              onLog: context.onLog,
            });
      const params = result.params as Record<string, unknown>;
      return {
        audio_path: result.outputPath,
        audio_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
        metadata: {
          kind: 'audio',
          task: 'music',
          model: params.model,
          prompt: params.prompt,
          lyrics: params.lyrics,
          duration_seconds: params.duration_seconds,
          steps: params.steps,
          seed: params.seed,
          duration_ms: result.durationMs,
          output_dir: paths.outputDir,
        },
      };
    }

    const result = await speech.generate({
      params: context.job.params as never,
      signal: context.signal,
      onLog: context.onLog,
    });

    return {
      audio_path: result.outputPath,
      audio_url: `/v1/outputs/${encodeURIComponent(result.outputName)}`,
      metadata: {
        kind: 'audio',
        model: result.params.model,
        input: result.params.input,
        voice: result.params.voice,
        voice_ref: result.params.voice_ref,
        instructions: result.params.instructions,
        duration_ms: result.durationMs,
        output_dir: paths.outputDir,
      },
    };
  };

  // Text is the one kind whose result is not a file — see services/text-gen.ts.
  const text: JobExecutor = async (context) => {
    const result = await textService.generate({
      params: context.job.params as never,
      signal: context.signal,
      onLog: context.onLog,
    });

    return {
      text: result.text,
      metadata: {
        kind: 'text',
        model: result.params.model,
        usage: result.usage,
        finish_reason: result.finishReason,
        duration_ms: result.durationMs,
      },
    };
  };

  return [
    {
      id: 'sdcpp',
      label: 'stable-diffusion.cpp and the Python runners',
      executors: () => ({ image: generate, video: generate }),
      // One process per job: nothing is held between them.
      resident: () => false,
      shutdown: async () => {
        images.killAll();
        pythonVideo.killAll();
      },
    },
    serverEngine(backends, 'audiocpp', 'audio.cpp', { audio }),
    serverEngine(backends, 'llamacpp', 'llama.cpp', { text }),
    serverEngine(backends, 'vllm', 'vLLM', {}),
  ];
}

/**
 * YuE2 in its own venv (python/pepper_runner/runners/yue2.py). Its package pins
 * torch 2.10 / transformers 4.57, so it cannot share the runner environment.
 * The model's weights are the bundle's; its VAE is fetched from HuggingFace on
 * first use into the models volume, hence the network being allowed.
 */
export const YUE2_ENVIRONMENT = {
  name: 'yue2',
  packages: ['https://huggingface.co/m-a-p/YuE2-3B/resolve/main/yue2_infer-0.1.5-py3-none-any.whl'],
};

async function pythonMusic(
  pythonVideo: PythonVideoService,
  paths: Paths,
  bundle: NonNullable<Awaited<ReturnType<ModelManager['find']>>>,
  context: JobContext,
): Promise<{ outputPath: string; outputName: string; durationMs: number; params: Record<string, unknown> }> {
  const params = context.job.params as {
    prompt: string;
    lyrics?: string;
    seed?: number;
  };
  const started = Date.now();
  const seed = params.seed !== undefined && params.seed >= 0 ? params.seed : randomInt(0, 2 ** 31 - 1);
  const outputName = uniqueOutputName('wav', 'music');
  const outputPath = safeResolve(paths.outputDir, outputName);
  await pythonVideo.runTask({
    runner: bundle.manifest?.python_runner ?? 'yue2',
    output: outputPath,
    environment: YUE2_ENVIRONMENT,
    env: { HF_HUB_OFFLINE: '0', HF_HOME: join(paths.modelsDir, '.hf-cache') },
    params: {
      model_dir: join(bundleDir(paths, 'audio', bundle.id), 'weights'),
      vae_dir: join(bundleDir(paths, 'audio', bundle.id), 'aux'),
      style: params.prompt,
      lyrics: params.lyrics ?? '',
      seed,
    },
    inputs: {},
    onProgress: context.onProgress,
    onLog: context.onLog,
    signal: context.signal,
  });
  return { outputPath, outputName, durationMs: Date.now() - started, params: { ...params, seed } };
}
