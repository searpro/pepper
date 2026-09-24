import { constants } from 'node:fs';
import { access, open, readdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { errors } from '../errors.js';
import type { StepProgress } from '../logs/parse.js';
import { safeResolve, type Paths } from '../paths.js';
import { ffmpegAvailable, runFfmpeg } from '../util/ffmpeg.js';
import { uniqueOutputName } from '../util/files.js';
import type { ImageService } from './image.js';

/**
 * ESRGAN upscaling of a generated (or uploaded) image, 2× or 4×.
 *
 * Runs through sd-cli's `upscale` mode rather than a Python stack: sd-cli is
 * already installed for generation, runs on Metal/CUDA, and reads the
 * RealESRGAN `.safetensors` checkpoints directly.
 *
 * One wrinkle decides the shape of this module: sd.cpp's ESRGAN graph only
 * implements the plain RRDBNet layout. RealESRGAN_x4plus is that; the official
 * RealESRGAN_x2plus is not — it pixel-unshuffles its input first (12 input
 * channels), which sd-cli rejects. So a 2× request tries any 2× model first
 * and, when none loads, runs the 4× model and halves the result with a Lanczos
 * resample. That is also what most upscaling front-ends do with x4plus, and it
 * looks better than a naive 2× network would on these images anyway.
 */

export type UpscaleScale = 2 | 4;

export interface UpscalerModel {
  name: string;
  path: string;
  /** Native scale, from the file name. */
  scale: number;
}

export interface UpscaleResult {
  outputPath: string;
  outputName: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: UpscaleScale;
  /** The checkpoint that did the work. */
  model: string;
  /** How the scale was reached: a single native pass, or 4× then a resample. */
  method: 'native' | 'x4+downscale';
  durationMs: number;
}

const MODEL_EXTS = ['.safetensors', '.pth', '.gguf', '.bin'];

export class UpscaleService {
  /**
   * Checkpoints sd-cli has already failed to load. Remembered for the life of
   * the process so every 2× request does not spend a model-load failing first.
   */
  private readonly unsupported = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly images: ImageService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async listModels(): Promise<UpscalerModel[]> {
    let names: string[];
    try {
      names = await readdir(this.config.upscaleModelsDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => MODEL_EXTS.includes(extname(name).toLowerCase()))
      .map((name) => ({
        name,
        path: join(this.config.upscaleModelsDir, name),
        scale: Number(/x(\d)/i.exec(name)?.[1] ?? 4),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Which scales can be produced with the checkpoints on disk. */
  async availableScales(): Promise<UpscaleScale[]> {
    const models = await this.listModels();
    const usable = models.filter((model) => !this.unsupported.has(model.path));
    const scales: UpscaleScale[] = [];
    if (usable.some((m) => m.scale === 2 || m.scale === 4)) scales.push(2);
    if (usable.some((m) => m.scale === 4)) scales.push(4);
    return scales;
  }

  /** Resolve an output or upload name to a readable path. */
  async resolveSource(name: string, source: 'output' | 'upload'): Promise<string> {
    const path = safeResolve(
      source === 'output' ? this.paths.outputDir : this.paths.uploadsDir,
      name,
    );
    try {
      await access(path, constants.R_OK);
    } catch {
      throw source === 'output' ? errors.outputNotFound(name) : errors.inputNotFound(name);
    }
    return path;
  }

  async upscale(options: {
    inputPath: string;
    scale: UpscaleScale;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<UpscaleResult> {
    const { inputPath, scale, signal } = options;
    const started = Date.now();
    const models = (await this.listModels()).filter((m) => !this.unsupported.has(m.path));

    const outputName = uniqueOutputName('png', `upscaled-${scale}x`);
    const outputPath = safeResolve(this.paths.outputDir, outputName);

    // 1. A checkpoint whose native scale is the one asked for.
    for (const model of models.filter((m) => m.scale === scale)) {
      const pass = await this.images.runUpscaler({
        modelPath: model.path,
        inputPath,
        outputPath,
        onProgress: options.onProgress,
        onLog: options.onLog,
        signal,
      });
      if (pass.to && pass.from) {
        return {
          outputPath,
          outputName,
          width: pass.to[0],
          height: pass.to[1],
          sourceWidth: pass.from[0],
          sourceHeight: pass.from[1],
          scale,
          model: model.name,
          method: 'native',
          durationMs: Date.now() - started,
        };
      }
      // sd-cli wrote a copy of the input rather than failing; do not leave it
      // behind looking like a result.
      await rm(outputPath, { force: true });
      this.unsupported.add(model.path);
      this.log.warn(
        { model: model.name },
        'sd-cli could not load this ESRGAN checkpoint (unsupported architecture); skipping it from now on',
      );
    }

    // 2. 2× from the 4× model plus a Lanczos resample.
    const x4 = models.find((m) => m.scale === 4);
    if (scale === 2 && x4) {
      if (!(await ffmpegAvailable())) {
        throw errors.validation(
          'No 2× upscaler that stable-diffusion.cpp can load, and ffmpeg (needed to derive 2× from the 4× model) is not installed.',
        );
      }
      const intermediate = safeResolve(
        this.paths.outputDir,
        uniqueOutputName('png', 'upscale-tmp'),
      );
      try {
        const pass = await this.images.runUpscaler({
          modelPath: x4.path,
          inputPath,
          outputPath: intermediate,
          onProgress: options.onProgress,
          onLog: options.onLog,
          signal,
        });
        if (!pass.from || !pass.to) {
          this.unsupported.add(x4.path);
          throw errors.generationFailed(`stable-diffusion.cpp could not load upscaler ${x4.name}`);
        }
        const [w, h] = [pass.from[0] * 2, pass.from[1] * 2];
        await runFfmpeg(['-i', intermediate, '-vf', `scale=${w}:${h}:flags=lanczos`, outputPath]);
        const [outW, outH] = (await pngSize(outputPath)) ?? [w, h];
        return {
          outputPath,
          outputName,
          width: outW,
          height: outH,
          sourceWidth: pass.from[0],
          sourceHeight: pass.from[1],
          scale,
          model: x4.name,
          method: 'x4+downscale',
          durationMs: Date.now() - started,
        };
      } finally {
        await rm(intermediate, { force: true });
      }
    }

    throw errors.validation(
      models.length === 0
        ? `No upscaler models found in ${this.config.upscaleModelsDir}. Add RealESRGAN_x4plus.safetensors there (or set UPSCALE_MODELS_DIR).`
        : `No usable ${scale}× upscaler in ${this.config.upscaleModelsDir} (found: ${models.map((m) => basename(m.path)).join(', ')}).`,
    );
  }
}

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(path: string): Promise<[number, number] | null> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(24);
    await file.read(header, 0, 24, 0);
    if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return [header.readUInt32BE(16), header.readUInt32BE(20)];
  } finally {
    await file.close();
  }
}
