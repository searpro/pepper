import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { defineSetting, type SettingsStore } from '../db/settings.js';
import { errors } from '../errors.js';
import type { StepProgress } from '../logs/parse.js';
import { safeResolve, type Paths } from '../paths.js';
import { ffmpegAvailable, runFfmpeg } from '../util/ffmpeg.js';
import { uniqueOutputName } from '../util/files.js';
import type { ImageService } from './image.js';
import type { PythonVideoService } from './python-video.js';
import {
  UPSCALER_CATALOGUE,
  catalogueEntryFor,
  sdcppCompatible,
  type UpscalerCatalogueEntry,
} from './upscalers-catalogue.js';

/**
 * Super-resolution of a generated (or uploaded) image, 2× or 4×.
 *
 * Two engines:
 *
 * - **python** — Pepper's `upscale` runner on spandrel, over the same managed
 *   Python runtime as the video models. It loads every architecture the
 *   upscaling community ships (ESRGAN old/new, RealESRGAN x2plus and compact,
 *   SPAN, RCAN, DAT, HAT…), runs fp16 on MPS/CUDA, and on an M4 is 10–20×
 *   faster than sd-cli for the same RRDBNet checkpoint.
 * - **sdcpp** — sd-cli's `upscale` mode. No Python needed, but its ESRGAN graph
 *   only implements plain RRDBNet, so it loads RealESRGAN x4plus, UltraSharp,
 *   Siax and the anime 6B model and nothing else. A 2× from sd-cli is the 4×
 *   model plus a Lanczos resample.
 *
 * `auto` (the default) uses Python once its runtime is installed, and sd-cli
 * for the checkpoints it can load until then — so a fresh install is not
 * made to download torch just to upscale with RealESRGAN.
 */

export type UpscaleScale = 2 | 4;
export type UpscaleEngine = 'auto' | 'python' | 'sdcpp';

export interface UpscalerModel {
  name: string;
  path: string;
  /** Native scale, from the catalogue or the file name. */
  scale: number;
  size: number;
  label: string;
  description?: string;
  architecture?: string;
  bestFor?: UpscalerCatalogueEntry['bestFor'];
  license?: string;
  /** Whether sd-cli can load it; `undefined` when not known. */
  sdcpp?: boolean;
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
  engine: 'python' | 'sdcpp';
  /** How the scale was reached: a single native pass, or a pass plus a resample. */
  method: string;
  architecture?: string;
  durationMs: number;
}

export const upscalerPreferencesSchema = z.object({
  engine: z.enum(['auto', 'python', 'sdcpp']).default('auto'),
  /** File name of the default checkpoint per requested scale; null picks one. */
  default_x2: z.string().nullable().default(null),
  default_x4: z.string().nullable().default(null),
});
export type UpscalerPreferences = z.infer<typeof upscalerPreferencesSchema>;

export const upscalerPreferencesKey = defineSetting<UpscalerPreferences>(
  'upscaler.preferences',
  upscalerPreferencesSchema,
  { engine: 'auto', default_x2: null, default_x4: null },
);

const MODEL_EXTS = ['.safetensors', '.pth', '.pt', '.ckpt', '.bin'];

/** What a scale falls back to when nothing is configured, best first. */
const PREFERRED: Record<UpscaleScale, string[]> = {
  4: ['4x-UltraSharp.safetensors', 'RealESRGAN_x4plus.safetensors', '4x_NMKD-Siax_200k.pth'],
  2: ['RealESRGAN_x2plus.pth', 'RealESRGAN_x2.safetensors', '4x-UltraSharp.safetensors'],
};

export class UpscaleService {
  /**
   * Checkpoints sd-cli has already failed to load. Remembered for the life of
   * the process so every request does not spend a model-load failing first.
   */
  private readonly unsupported = new Set<string>();
  private readonly installing = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly paths: Paths,
    private readonly images: ImageService,
    private readonly python: PythonVideoService,
    private readonly settings: SettingsStore,
    private readonly log: FastifyBaseLogger,
  ) {}

  get dir(): string {
    return this.config.upscaleModelsDir;
  }

  preferences(): UpscalerPreferences {
    return this.settings.get(upscalerPreferencesKey);
  }

  setPreferences(partial: Partial<UpscalerPreferences>): UpscalerPreferences {
    return this.settings.patch(upscalerPreferencesKey, partial);
  }

  async listModels(): Promise<UpscalerModel[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const models = await Promise.all(
      names
        .filter((name) => MODEL_EXTS.includes(extname(name).toLowerCase()))
        .map(async (name): Promise<UpscalerModel | null> => {
          const path = join(this.dir, name);
          const size = await stat(path).then((s) => s.size).catch(() => -1);
          if (size <= 0) return null;
          const entry = catalogueEntryFor(name);
          return {
            name,
            path,
            size,
            scale: entry?.scale ?? Number(/(?:^|[^a-z])x?(\d)x?(?:[^\d]|$)/i.exec(name)?.[1] ?? 4),
            label: entry?.label ?? name.replace(extname(name), ''),
            description: entry?.description,
            architecture: entry?.architecture,
            bestFor: entry?.bestFor,
            license: entry?.license,
            sdcpp: this.unsupported.has(path) ? false : sdcppCompatible(name),
          };
        }),
    );
    return models
      .filter((model): model is UpscalerModel => model !== null)
      .sort((a, b) => a.scale - b.scale || a.label.localeCompare(b.label));
  }

  /** The catalogue, each entry marked with whether it is on disk (or downloading). */
  async catalogue(): Promise<(UpscalerCatalogueEntry & { installed: boolean; installing: boolean })[]> {
    const installed = new Set((await this.listModels()).map((m) => m.name.toLowerCase()));
    return UPSCALER_CATALOGUE.map((entry) => ({
      ...entry,
      installed: installed.has(entry.file.toLowerCase()),
      installing: this.installing.has(entry.id),
    }));
  }

  /** Download a catalogue checkpoint into the upscaler directory. */
  async install(id: string): Promise<void> {
    const entry = UPSCALER_CATALOGUE.find((candidate) => candidate.id === id);
    if (!entry) throw errors.validation(`Unknown upscaler "${id}"`);
    const existing = this.installing.get(id);
    if (existing) return existing;

    const task = (async () => {
      await mkdir(this.dir, { recursive: true });
      const target = join(this.dir, entry.file);
      const partial = `${target}.part`;
      this.log.info({ id, url: entry.url }, 'downloading upscaler');
      const headers: Record<string, string> = {};
      if (this.config.hfToken && entry.url.startsWith('https://huggingface.co/')) {
        headers.Authorization = `Bearer ${this.config.hfToken}`;
      }
      const response = await fetch(entry.url, { headers, redirect: 'follow' });
      if (!response.ok || !response.body) {
        throw errors.generationFailed(`Downloading ${entry.label} failed: HTTP ${response.status}`);
      }
      try {
        await pipeline(
          Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
          createWriteStream(partial),
        );
        await rename(partial, target);
      } catch (err) {
        await rm(partial, { force: true });
        throw err;
      }
      this.log.info({ id, file: entry.file }, 'upscaler installed');
    })().finally(() => this.installing.delete(id));

    this.installing.set(id, task);
    return task;
  }

  async remove(name: string): Promise<void> {
    const path = safeResolve(this.dir, name);
    if (!MODEL_EXTS.includes(extname(name).toLowerCase())) {
      throw errors.validation('Not an upscaler checkpoint');
    }
    await rm(path, { force: true });
    const prefs = this.preferences();
    if (prefs.default_x2 === name) this.setPreferences({ default_x2: null });
    if (prefs.default_x4 === name) this.setPreferences({ default_x4: null });
  }

  /** Which scales can be produced with the checkpoints on disk. */
  async availableScales(): Promise<UpscaleScale[]> {
    const models = await this.listModels();
    if (models.length === 0) return [];
    // Python can reach either scale from any checkpoint (a pass plus a resample).
    if (this.preferences().engine !== 'sdcpp') return [2, 4];
    const usable = models.filter((model) => model.sdcpp !== false && !this.unsupported.has(model.path));
    const scales: UpscaleScale[] = [];
    if (usable.some((m) => m.scale === 2 || m.scale === 4)) scales.push(2);
    if (usable.some((m) => m.scale === 4)) scales.push(4);
    return scales;
  }

  /** The checkpoint a request for `scale` uses when it names none. */
  async defaultModel(scale: UpscaleScale): Promise<UpscalerModel | undefined> {
    const models = await this.listModels();
    const configured = this.preferences()[scale === 2 ? 'default_x2' : 'default_x4'];
    const byName = (name: string | null) =>
      name ? models.find((model) => model.name.toLowerCase() === name.toLowerCase()) : undefined;
    return (
      byName(configured) ??
      PREFERRED[scale].map(byName).find(Boolean) ??
      models.find((model) => model.scale === scale) ??
      models.find((model) => model.scale === 4) ??
      models[0]
    );
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
    /** A checkpoint file name in the upscaler directory; the default for the scale if omitted. */
    model?: string;
    onProgress?: (progress: StepProgress) => void;
    onLog?: (line: string) => void;
    signal?: AbortSignal;
  }): Promise<UpscaleResult> {
    const models = await this.listModels();
    if (models.length === 0) {
      throw errors.validation(
        `No upscaler models found in ${this.dir}. Install one from Preferences → Upscalers (or set UPSCALE_MODELS_DIR).`,
      );
    }
    const model = options.model
      ? models.find((candidate) => candidate.name === options.model)
      : await this.defaultModel(options.scale);
    if (!model) {
      throw errors.validation(
        `Upscaler "${options.model}" is not in ${this.dir} (found: ${models.map((m) => m.name).join(', ')}).`,
      );
    }

    const engine = await this.engineFor(model);
    options.onLog?.(`Upscaling ${options.scale}× with ${model.label} (${engine})`);
    if (engine === 'python') return this.upscalePython(model, options);
    return this.upscaleSdcpp(model, models, options);
  }

  private async engineFor(model: UpscalerModel): Promise<'python' | 'sdcpp'> {
    const { engine } = this.preferences();
    if (engine === 'python') return 'python';
    if (engine === 'sdcpp') {
      if (model.sdcpp === false) {
        throw errors.validation(
          `${model.label} (${model.architecture ?? 'this architecture'}) needs the Python engine — stable-diffusion.cpp only loads plain RRDBNet checkpoints. Switch the upscaler engine to Auto or Python in Preferences.`,
        );
      }
      return 'sdcpp';
    }
    if (await this.python.runtimeInstalled()) return 'python';
    return model.sdcpp === false ? 'python' : 'sdcpp';
  }

  private async upscalePython(
    model: UpscalerModel,
    options: {
      inputPath: string;
      scale: UpscaleScale;
      onProgress?: (progress: StepProgress) => void;
      onLog?: (line: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<UpscaleResult> {
    const started = Date.now();
    await mkdir(this.paths.outputDir, { recursive: true });
    const outputName = uniqueOutputName('png', `upscaled-${options.scale}x`);
    const outputPath = safeResolve(this.paths.outputDir, outputName);
    const result = await this.python.runTask({
      runner: 'upscale',
      output: outputPath,
      params: { model: model.path, scale: options.scale },
      inputs: { image: options.inputPath },
      onProgress: options.onProgress,
      onLog: options.onLog,
      signal: options.signal,
    });
    return {
      outputPath,
      outputName,
      width: Number(result.width),
      height: Number(result.height),
      sourceWidth: Number(result.source_width),
      sourceHeight: Number(result.source_height),
      scale: options.scale,
      model: model.name,
      engine: 'python',
      method: String(result.method ?? 'native'),
      architecture: result.architecture as string | undefined,
      durationMs: Date.now() - started,
    };
  }

  private async upscaleSdcpp(
    chosen: UpscalerModel,
    all: UpscalerModel[],
    options: {
      inputPath: string;
      scale: UpscaleScale;
      onProgress?: (progress: StepProgress) => void;
      onLog?: (line: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<UpscaleResult> {
    const { inputPath, scale, signal } = options;
    const started = Date.now();
    const outputName = uniqueOutputName('png', `upscaled-${scale}x`);
    const outputPath = safeResolve(this.paths.outputDir, outputName);

    // 1. The chosen checkpoint, when its native scale is the one asked for.
    if (chosen.scale === scale && !this.unsupported.has(chosen.path)) {
      const pass = await this.images.runUpscaler({
        modelPath: chosen.path,
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
          model: chosen.name,
          engine: 'sdcpp',
          method: 'native',
          durationMs: Date.now() - started,
        };
      }
      // sd-cli wrote a copy of the input rather than failing; do not leave it
      // behind looking like a result.
      await rm(outputPath, { force: true });
      this.markUnsupported(chosen);
    }

    // 2. 2× from a 4× model plus a Lanczos resample.
    const x4 =
      chosen.scale === 4 && !this.unsupported.has(chosen.path)
        ? chosen
        : all.find((m) => m.scale === 4 && m.sdcpp !== false && !this.unsupported.has(m.path));
    if (scale === 2 && x4) {
      if (!(await ffmpegAvailable())) {
        throw errors.validation(
          'No 2× upscaler that stable-diffusion.cpp can load, and ffmpeg (needed to derive 2× from the 4× model) is not installed.',
        );
      }
      const intermediate = safeResolve(this.paths.outputDir, uniqueOutputName('png', 'upscale-tmp'));
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
          this.markUnsupported(x4);
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
          engine: 'sdcpp',
          method: 'x4+downscale',
          durationMs: Date.now() - started,
        };
      } finally {
        await rm(intermediate, { force: true });
      }
    }

    throw errors.validation(
      `stable-diffusion.cpp cannot produce ${scale}× with ${basename(chosen.path)}. Switch the upscaler engine to Auto or Python in Preferences.`,
    );
  }

  private markUnsupported(model: UpscalerModel): void {
    this.unsupported.add(model.path);
    this.log.warn(
      { model: model.name },
      'sd-cli could not load this upscaler checkpoint (unsupported architecture); skipping it from now on',
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
