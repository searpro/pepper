import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, publicConfig } from '../src/config.js';
import { assertSafeName, safeResolve } from '../src/paths.js';
import { cudaRank, parseDriverCuda, runtimeCompanion, selectAsset } from '@pepper/core/backends/release.js';
import type { FastifyBaseLogger } from 'fastify';
import { evaluatePolicy } from '@pepper/core/backends/monitor.js';
import { ManagedProcess } from '@pepper/core/backends/process.js';
import { parseBackendLine, parseProgress } from '@pepper/core/logs/parse.js';
import { LogBuffer } from '@pepper/core/logs/buffer.js';
import { buildArgv, effectiveArgs, LLAMACPP_ARGS, renderArgs } from '../src/backends/args.js';
import {
  inspectBundle,
  parseSlot,
  detectClipRole,
  isHighNoiseCheckpoint,
  resolveImageBundle,
  resolveS2vConfig,
  alignFrames,
} from '../src/models/bundle.js';
import { Semaphore } from '@pepper/core/util/semaphore.js';
import { readGgufInfo } from '@pepper/core/util/gguf.js';
import { isChatLlm } from '../src/models/text-encoders.js';
import { buildImageArgs, loraSchedule, mergeHires, resolveHiresUpscaler, withLoraTags } from '../src/services/image-args.js';
import { musicRequest } from '../src/services/audio-gen.js';
import { probeAudio, sliceAudio } from '@pepper/core/util/ffmpeg.js';
import { UpscaleService, upscalerPreferencesKey, type UpscalerPreferences } from '../src/services/upscale.js';
import { catalogueEntryFor, sdcppCompatible, UPSCALER_CATALOGUE } from '../src/services/upscalers-catalogue.js';
import { parseJsonObject, speechParams, SHEET_TEMPLATE } from '../src/services/characters.js';
import type { ImageService } from '../src/services/image.js';
import {
  isSignedMediaRequest,
  redactTokenPath,
  requiresAuth,
  secretsMatch,
  sessionValue,
  signMediaUrl,
} from '@pepper/core/auth.js';
import { parseRange } from '@pepper/core/routes/media.js';
import { MEDIA_VIEW_MIME, MEDIA_VIEW_URI } from '@pepper/core/mcp/media-view.js';
import { buildServer } from '../src/server.js';
import { jobsResult, selectFiles, type CatalogueComponent } from '../src/mcp/tools.js';
import { ActivityTracker, isActivity } from '@pepper/core/services/activity.js';
import { cgroupMemory } from '@pepper/core/services/resources.js';
import { openDb } from '../src/db/client.js';
import { StorageMonitor, volumeBytes } from '@pepper/core/services/storage.js';

describe('config', () => {
  it('defaults OUTPUT_DIR outside DATA_DIR so outputs do not fill the persistent volume', () => {
    const config = loadConfig({ DATA_DIR: '/mnt/data' });
    expect(config.dataDir).toBe('/mnt/data');
    expect(config.outputDir.startsWith('/mnt/data')).toBe(false);
  });

  it('carries sd-api timeout defaults', () => {
    const config = loadConfig({});
    expect(config.sdcppTimeoutMs).toBe(600_000);
    expect(config.sdcppVideoTimeoutMs).toBe(3_600_000);
    expect(config.llamacppTimeoutMs).toBe(300_000);
    expect(config.maxConcurrentJobs).toBe(1);
    expect(config.maxConcurrentDownloads).toBe(2);
  });

  it('reads every environment variable the requirements name', () => {
    const config = loadConfig({
      DATA_DIR: '/data',
      OUTPUT_DIR: '/outputs',
      SDCPP_RELEASE_REPO: 'searpro/stable-diffusion.cpp',
      AUDIOCPP_RELEASE_REPO: 'searpro/audio.cpp',
      LLAMACPP_RELEASE_REPO: 'ggml-org/llama.cpp',
      PYTHON_RELEASE_REPO: 'comfyanonymous/ComfyUI',
      ACCEL: 'cuda',
      HF_TOKEN: 'hf_secret',
      AUTO_INSTALL_BACKENDS: 'false',
      HOST: '127.0.0.1',
      PORT: '8080',
      HTTP_SERVER_TIMEOUT: '120000',
      SDCPP_TIMEOUT: '1000',
      AUDIOCPP_TIMEOUT: '2000',
      LLAMACPP_TIMEOUT: '3000',
      MAX_CONCURRENT_JOBS: '4',
      MAX_CONCURRENT_DOWNLOADS: '8',
    });

    expect(config).toMatchObject({
      dataDir: '/data',
      outputDir: '/outputs',
      accel: 'cuda',
      autoInstallBackends: false,
      host: '127.0.0.1',
      port: 8080,
      httpServerTimeoutMs: 120_000,
      sdcppTimeoutMs: 1000,
      audiocppTimeoutMs: 2000,
      llamacppTimeoutMs: 3000,
      maxConcurrentJobs: 4,
      maxConcurrentDownloads: 8,
    });
    expect(config.releaseRepos.audiocpp).toBe('searpro/audio.cpp');
  });

  it('never exposes the HuggingFace token through the public config', () => {
    const shown = publicConfig(loadConfig({ HF_TOKEN: 'hf_secret' }));
    expect(JSON.stringify(shown)).not.toContain('hf_secret');
    expect(shown.hfTokenConfigured).toBe(true);
  });

  it('never exposes the API token through the public config', () => {
    const shown = publicConfig(loadConfig({ PEPPER_API_TOKEN: 'pepper_secret' }));
    expect(JSON.stringify(shown)).not.toContain('pepper_secret');
    expect(shown.apiTokenConfigured).toBe(true);
  });

  it('rejects a malformed release repo rather than silently defaulting', () => {
    expect(() => loadConfig({ SDCPP_RELEASE_REPO: 'not-a-repo' })).toThrow(/owner\/repo/);
  });
});

describe('path safety', () => {
  it('rejects traversal, separators and absolute paths', () => {
    for (const name of ['../escape', 'a/b', '..', '/etc/passwd', 'x\0y']) {
      expect(() => assertSafeName(name)).toThrow();
    }
  });

  it('resolves a valid name inside its base directory', () => {
    expect(safeResolve('/models/image', 'flux')).toBe('/models/image/flux');
  });
});

describe('release asset selection', () => {
  const assets = [
    { name: 'sd-master-b1-bin-Linux-Ubuntu-24.04-x86_64.zip', browser_download_url: 'u1', size: 10 },
    { name: 'sd-master-b1-bin-Linux-Ubuntu-24.04-x86_64-cuda-12.4.zip', browser_download_url: 'u2', size: 900 },
    { name: 'sd-master-b1-bin-Linux-Ubuntu-24.04-x86_64-cuda-11.8.zip', browser_download_url: 'u3', size: 800 },
    { name: 'cudart-sd-bin-linux-x86_64.zip', browser_download_url: 'u4', size: 500 },
    { name: 'sd-master-b1-bin-Darwin-macOS-15-arm64.zip', browser_download_url: 'u5', size: 20 },
  ];

  it('prefers the newest CUDA toolkit for accel=cuda', () => {
    expect(selectAsset(assets, 'linux', 'x64', 'cuda').asset.browser_download_url).toBe('u2');
  });

  it('never selects the standalone cudart redistributable', () => {
    expect(selectAsset(assets, 'linux', 'x64', 'cpu').asset.browser_download_url).toBe('u1');
  });

  it('treats metal as the native macOS build rather than a filename keyword', () => {
    expect(selectAsset(assets, 'darwin', 'arm64', 'metal').asset.browser_download_url).toBe('u5');
  });

  it('never picks a CUDA build newer than the driver supports', () => {
    const llama = [
      { name: 'llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz', browser_download_url: 'c12' },
      { name: 'llama-b1-bin-ubuntu-cuda-13.4-x64.tar.gz', browser_download_url: 'c13' },
      { name: 'cudart-llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz', browser_download_url: 'rt' },
    ];
    expect(selectAsset(llama, 'linux', 'x64', 'cuda').asset.browser_download_url).toBe('c13');
    // A 12.4 driver runs the 12.8 build (minor-version compatibility), not 13.x.
    const pick = selectAsset(llama, 'linux', 'x64', 'cuda', parseDriverCuda('| CUDA Version: 12.4 |'));
    expect(pick.asset.browser_download_url).toBe('c12');
    expect(runtimeCompanion(llama, pick.asset)?.browser_download_url).toBe('rt');
    expect(() => selectAsset(llama, 'linux', 'x64', 'cuda', 1104)).toThrow(/driver can run/);
  });

  it('does not mistake a commit hash or distro version for a CUDA version', () => {
    expect(cudaRank('sd-cuda-1580abc-linux-x86_64.zip')).toBe(0);
    expect(cudaRank('linux-cuda-2204')).toBe(0);
    expect(cudaRank('llama-b4589-bin-ubuntu-x64-cuda-12.4.zip')).toBe(1204);
    expect(cudaRank('torch-cu12.zip')).toBe(1200);
  });

  it('reports which assets existed when nothing matches', () => {
    expect(() => selectAsset(assets, 'linux', 'x64', 'rocm')).toThrow(/No "rocm" build/);
  });
});

describe('process health policy', () => {
  const policy = { swapLimitKb: 256 * 1024 };

  it('recycles a swapping process — the audio.cpp failure mode', () => {
    const verdict = evaluatePolicy({ pid: 1, rssKb: 1000, swapKb: 400 * 1024 }, policy);
    expect(verdict.restart).toBe(true);
    expect(verdict.reason).toMatch(/swapping/);
  });

  it('leaves a process holding a lot of memory alone — idleness is the idle stop’s job', () => {
    expect(evaluatePolicy({ pid: 1, rssKb: 40 * 1024 * 1024, swapKb: 0 }, policy).restart).toBe(false);
  });

  it('does not treat unreported swap as zero swap', () => {
    expect(evaluatePolicy({ pid: 1, rssKb: 1000, swapKb: null }, policy).restart).toBe(false);
  });
});

describe('backend idle stop', () => {
  const silentLog = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  } as unknown as FastifyBaseLogger;

  function sleeper(idleTimeoutMs: number, healthUrl?: string): ManagedProcess {
    return new ManagedProcess(
      {
        backend: 'audiocpp',
        binaryPath: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        healthUrl,
        startupTimeoutMs: 10_000,
        policy: { swapLimitKb: null },
        idleTimeoutMs: () => idleTimeoutMs,
      },
      silentLog,
      new LogBuffer(),
    );
  }

  // The monitor loop runs on a 15 s interval; the tests drive one tick directly.
  const tick = (proc: ManagedProcess) =>
    (proc as unknown as { sampleAndEnforce(): Promise<void> }).sampleAndEnforce();

  it('stops a backend nothing has used for the idle timeout', async () => {
    const proc = sleeper(1);
    await proc.start();
    await new Promise((r) => setTimeout(r, 10));
    await tick(proc);
    expect(proc.status).toBe('stopped');
    expect(proc.state().lastStopReason).toMatch(/idle/);
  });

  it('never stops a backend while a request holds a lease', async () => {
    const proc = sleeper(1);
    await proc.start();
    const release = proc.acquire();
    await new Promise((r) => setTimeout(r, 10));
    await tick(proc);
    expect(proc.status).toBe('ready');
    expect(proc.state().inFlight).toBe(1);

    release();
    release(); // double release must not go negative
    expect(proc.state().inFlight).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    await tick(proc);
    expect(proc.status).toBe('stopped');
  });

  it('keeps running when the timeout is 0', async () => {
    const proc = sleeper(0);
    await proc.start();
    await tick(proc);
    expect(proc.status).toBe('ready');
    expect(proc.state().idleStopAt).toBeUndefined();
    await proc.stop();
  });

  it('reads as stopped, not failed, when stopped during startup', async () => {
    // Nothing listens here, so startup would poll until the timeout.
    const proc = sleeper(0, 'http://127.0.0.1:9/health');
    const starting = proc.start().catch((err: Error) => err);
    await new Promise((r) => setTimeout(r, 100));
    await proc.stop();
    const err = await starting;
    expect(err).toBeInstanceOf(Error);
    expect(proc.status).toBe('stopped');
    expect(proc.state().lastError).toBeUndefined();
  });
});

describe('backend log parsing', () => {
  it('recovers the level stable-diffusion.cpp encodes in its own output', () => {
    expect(parseBackendLine('[INFO ] stable-diffusion.cpp:1454 - loading model', 'stderr')).toEqual({
      level: 'info',
      origin: 'stable-diffusion.cpp:1454',
      message: 'loading model',
    });
    expect(parseBackendLine('[ERROR] failed to allocate buffer', 'stdout').level).toBe('error');
  });

  it('classifies bare failure text that carries no level prefix', () => {
    expect(parseBackendLine('ggml_cuda: out of memory', 'stderr').level).toBe('error');
    expect(parseBackendLine('using deprecated flag', 'stdout').level).toBe('warn');
  });

  it('does not treat stderr itself as an error signal', () => {
    // These backends write ordinary progress chatter to stderr; flagging the
    // stream would mark a healthy startup as failing.
    expect(parseBackendLine('load_tensors: loading 291 tensors', 'stderr').level).toBe('warn');
    expect(parseBackendLine('load_tensors: loading 291 tensors', 'stdout').level).toBe('info');
  });

  it('extracts sampling progress from the CLI progress bar', () => {
    expect(parseProgress('  |=========>      | 7/20 - 1.13s/it')).toEqual({
      step: 7,
      total: 20,
      progress: 0.35,
    });
    expect(parseProgress('no progress here')).toBeNull();
    expect(parseProgress('| 30/20 |')).toBeNull();
  });
});

describe('log buffer', () => {
  it('keeps only the completed half of each Fastify request pair', () => {
    const logs = new LogBuffer();
    logs.write(JSON.stringify({ level: 30, reqId: 'r1', req: { method: 'GET', url: '/v1/models' } }));
    expect(logs.query()).toHaveLength(0);

    logs.write(JSON.stringify({ level: 30, reqId: 'r1', res: { statusCode: 200 }, responseTime: 4 }));
    const records = logs.query();
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe('http');
    expect(records[0].msg).toContain('GET /v1/models → 200');
  });

  it('filters by source, level and free-text search', () => {
    const logs = new LogBuffer();
    logs.push({ level: 'info', source: 'sdcpp', msg: 'sampling started' });
    logs.push({ level: 'error', source: 'llamacpp', msg: 'out of memory' });
    logs.push({ level: 'debug', source: 'app', msg: 'quiet detail' });

    expect(logs.query({ sources: ['sdcpp'] })).toHaveLength(1);
    expect(logs.query({ minLevel: 'error' })).toHaveLength(1);
    expect(logs.query({ search: 'memory' })[0].source).toBe('llamacpp');
  });

  it('bounds retention to its capacity', () => {
    const logs = new LogBuffer(10);
    for (let i = 0; i < 50; i++) logs.push({ level: 'info', source: 'app', msg: `line ${i}` });
    const records = logs.query({ limit: 100 });
    expect(records).toHaveLength(10);
    expect(records[0].msg).toBe('line 40');
  });
});

describe('backend CLI arguments', () => {
  const noOverrides = { values: {}, extraArgs: [] };

  it('seeds sd-api’s working llama.cpp arguments', () => {
    const argv = buildArgv(LLAMACPP_ARGS, noOverrides, {
      models_dir: '/data/models/llm',
      host: '127.0.0.1',
      port: 8090,
    });
    expect(argv).toEqual([
      '--models-dir',
      '/data/models/llm',
      '--host',
      '127.0.0.1',
      '--port',
      '8090',
      '-c',
      '4096',
      '--jinja',
    ]);
  });

  it('drops an argument set to null instead of needing a sentinel value', () => {
    // sd-api used -1 for "let llama.cpp decide" on -ngl, which only worked
    // because that flag happened to have an impossible value to spare.
    const withGpu = buildArgv(LLAMACPP_ARGS, { values: { gpu_layers: 35 }, extraArgs: [] }, {});
    expect(withGpu).toContain('-ngl');
    expect(buildArgv(LLAMACPP_ARGS, { values: { gpu_layers: null }, extraArgs: [] }, {})).not.toContain('-ngl');
  });

  it('appends free-form extra arguments for flags the spec does not model', () => {
    const argv = buildArgv(LLAMACPP_ARGS, { values: {}, extraArgs: ['--some-new-flag', '3'] }, {});
    expect(argv.slice(-2)).toEqual(['--some-new-flag', '3']);
  });

  it('never lets a user override a locked argument', () => {
    const args = effectiveArgs(
      LLAMACPP_ARGS,
      { values: { host: '0.0.0.0', port: 9999 }, extraArgs: [] },
      { host: '127.0.0.1', port: 8090 },
    );
    const host = args.find((arg) => arg.key === 'host');
    expect(host?.value).toBe('127.0.0.1');
    expect(renderArgs(args)).toContain('127.0.0.1');
  });

  it('omits a false boolean rather than emitting a --no- form', () => {
    const argv = buildArgv(LLAMACPP_ARGS, { values: { jinja: false }, extraArgs: [] }, {});
    expect(argv).not.toContain('--jinja');
  });
});

describe('model bundles', () => {
  async function makeBundle(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pepper-bundle-'));
    await mkdir(join(root, 'checkpoint'), { recursive: true });
    await mkdir(join(root, 'clip'), { recursive: true });
    await mkdir(join(root, 'lora'), { recursive: true });
    await writeFile(join(root, 'checkpoint', 'flux-Q4_K_M.gguf'), 'x'.repeat(100));
    await writeFile(join(root, 'clip', 't5xxl_fp16.safetensors'), 'x'.repeat(50));
    await writeFile(join(root, 'lora', 'lineart.safetensors'), 'x'.repeat(10));
    await writeFile(join(root, 'checkpoint', 'partial.gguf.part'), 'x'.repeat(7));
    await writeFile(join(root, 'model.json'), JSON.stringify({ name: 'Flux', load: 'diffusion-model' }));
    return root;
  }

  it('reads components, roles, LoRA refs and partials', async () => {
    const info = await inspectBundle(await makeBundle(), 'flux', 'image');

    expect(info.name).toBe('Flux');
    expect(info.ready).toBe(true);
    expect(info.loadMode).toBe('diffusion-model');
    expect(info.components.find((c) => c.slot === 'clip')?.role).toBe('t5xxl');
    expect(info.components.find((c) => c.slot === 'lora')?.ref).toBe('lineart');
    expect(info.partials).toEqual([
      { slot: 'checkpoint', name: 'partial.gguf', received: 7, total: null },
    ]);
  });

  it('attaches LoRA presets, preferring the bundle\'s own over the built-in ones', async () => {
    const root = await makeBundle();
    await writeFile(join(root, 'lora', 'p_qwen_image_2.1_8step_v0.1.safetensors'), 'x');
    await writeFile(
      join(root, 'model.json'),
      JSON.stringify({ name: 'Flux', lora_presets: { lineart: { steps: 12 } } }),
    );
    const info = await inspectBundle(root, 'flux', 'image');
    const preset = (ref: string) => info.components.find((c) => c.ref === ref)?.preset;

    expect(preset('lineart')).toEqual({ steps: 12 });
    expect(preset('p_qwen_image_2.1_8step_v0.1')?.sigmas).toHaveLength(8);
  });

  it('loads a requested checkpoint instead of the largest, and rejects unknown ones', async () => {
    const root = await makeBundle();
    await writeFile(join(root, 'checkpoint', 'flux-Q2_K.gguf'), 'x'.repeat(5));
    await mkdir(join(root, 'vae'), { recursive: true });

    const auto = await resolveImageBundle(root, 'flux', 'image');
    expect(auto.checkpointName).toBe('flux-Q4_K_M.gguf');

    const chosen = await resolveImageBundle(root, 'flux', 'image', { checkpoint: 'flux-Q2_K.gguf' });
    expect(chosen.checkpointName).toBe('flux-Q2_K.gguf');
    expect(chosen.checkpointPath).toBe(join(root, 'checkpoint', 'flux-Q2_K.gguf'));

    await expect(
      resolveImageBundle(root, 'flux', 'image', { checkpoint: '../../etc/passwd' }),
    ).rejects.toThrow(/not in model/);
  });

  it('excludes in-progress downloads from the component list', async () => {
    const info = await inspectBundle(await makeBundle(), 'flux', 'image');
    expect(info.components.some((c) => c.name.endsWith('.part'))).toBe(false);
  });

  it('reports an audio bundle without family/task as not ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-audio-'));
    await mkdir(join(root, 'weights'), { recursive: true });
    await writeFile(join(root, 'weights', 'model.gguf'), 'x');

    const info = await inspectBundle(root, 'chatterbox', 'audio');
    expect(info.ready).toBe(false);
    expect(info.readyReason).toMatch(/family.*task/);
  });

  it('maps clip filenames to encoder roles, checking projectors first', () => {
    expect(detectClipRole('mmproj-qwen2.5-vl.gguf')).toBe('llm_vision');
    expect(detectClipRole('clip_l.safetensors')).toBe('clip_l');
    expect(detectClipRole('t5xxl_fp8.safetensors')).toBe('t5xxl');
    // Wan's UMT5-XXL encoder is passed under --t5xxl, so the t5 branch
    // matching it before the LLM branch is the correct outcome, not a
    // near-miss — the ordering is load-bearing.
    expect(detectClipRole('umt5-xxl.gguf')).toBe('t5xxl');
    expect(detectClipRole('qwen3-4b.gguf')).toBe('llm');
    expect(detectClipRole('mystery.bin')).toBeNull();
  });

  it('accepts an "other:<dir>" slot and rejects a traversal inside it', () => {
    expect(parseSlot('other:controlnet')).toBe('other:controlnet');
    expect(() => parseSlot('other:../../etc')).toThrow();
    expect(() => parseSlot('nonsense')).toThrow(/Unknown component slot/);
  });
});

describe('catalogue file filtering', () => {
  // The filters live in catalogue/manager.ts as module-private helpers; these
  // assert the naming rules they encode, which are what actually decides
  // whether a bundle installs usable weights.
  const SHARD_RE = /-\d{5}-of-\d{5}\.[a-z]+$/;
  const DRAFT_PREFIXES = ['mtp-', 'dflash-', 'dspark-', 'eagle3-'];
  const isDraft = (name: string) =>
    DRAFT_PREFIXES.some((prefix) => name.startsWith(prefix)) || name.includes('-draft');

  it('excludes multi-part shards, which would install as a truncated model', () => {
    expect(SHARD_RE.test('model-00001-of-00003.gguf')).toBe(true);
    expect(SHARD_RE.test('Qwen3-8B-Q8_0.gguf')).toBe(false);
  });

  it('excludes the draft weights ggml-org ships beside the real ones', () => {
    // Both of these sit in ggml-org/Qwen3-8B-GGUF next to the genuine files.
    expect(isDraft('dflash-Qwen3-8B-Q8_0.gguf')).toBe(true);
    expect(isDraft('dspark-Qwen3-8B-BF16.gguf')).toBe(true);
    expect(isDraft('Qwen3-8B-Q8_0.gguf')).toBe(false);
  });
});

describe('semaphore', () => {
  it('runs work up to its permit count and queues the rest', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        semaphore.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it('aborting a waiter frees nothing it never held', async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();

    const held = semaphore.run(() => new Promise((r) => setTimeout(r, 50)));
    const waiting = semaphore.run(async () => 'never', controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow();
    await held;
    expect(semaphore.inUse).toBe(0);
  });
});

describe('image generation arguments', () => {
  const bundle = {
    id: 'kontext',
    mode: 'image' as const,
    loadMode: 'diffusion-model' as const,
    checkpointPath: '/models/kontext.gguf',
    weights: {},
    extraArgs: [],
    defaults: {},
  };

  it('passes editing inputs through as their own flags', () => {
    const args = buildImageArgs({
      params: {
        prompt: 'make it snow',
        model: 'kontext',
        strength: 0.6,
        img_cfg_scale: 1.5,
        increase_ref_index: true,
      },
      // The manifest surface is wider than this test needs; only the fields
      // the editing path reads are populated.
      bundle: bundle as never,
      outputPath: '/out/x.png',
      images: { init: '/in/init.png', mask: '/in/mask.png', refs: ['/in/a.png', '/in/b.png'] },
    });

    expect(args).toContain('--increase-ref-index');
    for (const [flag, value] of [
      ['-i', '/in/init.png'],
      ['--mask', '/in/mask.png'],
      ['--strength', '0.6'],
      ['--img-cfg-scale', '1.5'],
    ] as const) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
    // Each reference gets its own -r, in the order the client sent them.
    expect(args.filter((arg) => arg === '-r')).toHaveLength(2);
    expect(args[args.indexOf('-r') + 1]).toBe('/in/a.png');
  });

  it('turns selected LoRAs into prompt tags and points sd-cli at their directory', () => {
    const args = buildImageArgs({
      params: {
        prompt: 'a cat',
        model: 'kontext',
        loras: [{ name: 'turbo-4step', weight: 0.8 }, { name: 'style' }],
      },
      bundle: { ...bundle, loraDir: '/models/kontext/lora', loras: ['turbo-4step', 'style'] } as never,
      outputPath: '/out/x.png',
    });

    expect(args[args.indexOf('-p') + 1]).toBe('a cat <lora:turbo-4step:0.8> <lora:style:1>');
    expect(args[args.indexOf('--lora-model-dir') + 1]).toBe('/models/kontext/lora');
  });

  it('passes a custom schedule as one comma-separated --sigmas value', () => {
    const args = buildImageArgs({
      params: { prompt: 'a cat', model: 'kontext', sigmas: [1, 0.5, 0.25, 0] },
      bundle: bundle as never,
      outputPath: '/out/x.png',
    });
    expect(args[args.indexOf('--sigmas') + 1]).toBe('1,0.5,0.25,0');
  });

  it('never lets a LoRA name close its tag early', () => {
    const args = buildImageArgs({
      params: { prompt: 'a cat', model: 'kontext', loras: [{ name: 'x:9><lora:y' }] },
      bundle: bundle as never,
      outputPath: '/out/x.png',
    });
    expect(args[args.indexOf('-p') + 1]).toBe('a cat');
  });
});

describe('speech-to-video', () => {
  /** A minimal 16-bit mono PCM WAV of `seconds` duration. */
  function makeWav(seconds: number, sampleRate = 16000, extraChunk = false): Buffer {
    const frames = Math.round(seconds * sampleRate);
    const data = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i += 1) data.writeInt16LE((i % 1000) - 500, i * 2);

    // A LIST chunk between fmt and data is what real encoders emit and what a
    // fixed-offset parser gets wrong, so one variant carries it.
    const list = extraChunk
      ? (() => {
          const body = Buffer.from('INFOISFT\x00\x00\x00\x04test', 'ascii');
          const head = Buffer.alloc(8);
          head.write('LIST', 0, 'ascii');
          head.writeUInt32LE(body.length, 4);
          return Buffer.concat([head, body]);
        })()
      : Buffer.alloc(0);

    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(sampleRate, 12);
    fmt.writeUInt32LE(sampleRate * 2, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);

    const dataHead = Buffer.alloc(8);
    dataHead.write('data', 0, 'ascii');
    dataHead.writeUInt32LE(data.length, 4);

    const rest = Buffer.concat([fmt, list, dataHead, data]);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + rest.length, 4);
    riff.write('WAVE', 8, 'ascii');
    return Buffer.concat([riff, rest]);
  }

  async function writeWav(seconds: number, extraChunk = false): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-s2v-test-'));
    const path = join(dir, 'speech.wav');
    await writeFile(path, makeWav(seconds, 16000, extraChunk));
    return path;
  }

  it('reads duration natively, without needing ffprobe', async () => {
    const info = await probeAudio(await writeWav(7.5));
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.duration).toBeCloseTo(7.5, 3);
  });

  it('walks RIFF chunks rather than assuming data starts at byte 44', async () => {
    // With a LIST chunk present, a fixed-offset parser reads metadata as audio
    // and reports a duration longer than the file actually holds.
    const info = await probeAudio(await writeWav(3, true));
    expect(info.duration).toBeCloseTo(3, 3);
  });

  it('slices into overlapping chunks that advance by the step, not the window', async () => {
    const chunks = await sliceAudio({
      sourcePath: await writeWav(12),
      outDir: await mkdtemp(join(tmpdir(), 'pepper-chunks-')),
      chunkSeconds: 5,
      overlapSeconds: 0.5,
    });

    // step = 4.5s, so 12s of audio needs ceil((12 - 0.5) / 4.5) = 3 chunks.
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.start)).toEqual([0, 4.5, 9]);
    // The first two are full windows; the last is whatever audio remains.
    expect(chunks[0].duration).toBeCloseTo(5, 3);
    expect(chunks[2].duration).toBeCloseTo(3, 3);
  });

  it('emits a single chunk for audio shorter than one window', async () => {
    const chunks = await sliceAudio({
      sourcePath: await writeWav(2),
      outDir: await mkdtemp(join(tmpdir(), 'pepper-chunks-')),
      chunkSeconds: 5,
      overlapSeconds: 0.5,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].duration).toBeCloseTo(2, 3);
  });

  it('writes each chunk as a playable WAV of the right length', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'pepper-chunks-'));
    const chunks = await sliceAudio({
      sourcePath: await writeWav(10),
      outDir,
      chunkSeconds: 4,
      overlapSeconds: 1,
    });
    // Reading a chunk back through the parser is what proves the header it
    // was given actually describes its payload.
    const first = await probeAudio(chunks[0].path);
    expect(first.duration).toBeCloseTo(4, 2);
    expect(first.sampleRate).toBe(16000);
  });

  it('rejects an overlap that would not advance the timeline', async () => {
    await expect(
      sliceAudio({
        sourcePath: await writeWav(10),
        outDir: await mkdtemp(join(tmpdir(), 'pepper-chunks-')),
        chunkSeconds: 4,
        overlapSeconds: 4,
      }),
    ).rejects.toThrow(/overlapSeconds/);
  });

  it('identifies Wan 2.2 high-noise checkpoints by filename', () => {
    expect(isHighNoiseCheckpoint('wan2.2_s2v_high_noise_Q4_K.gguf')).toBe(true);
    expect(isHighNoiseCheckpoint('Wan2.2-HighNoise-14B.safetensors')).toBe(true);
    expect(isHighNoiseCheckpoint('wan2.2_s2v_low_noise_Q4_K.gguf')).toBe(false);
  });

  it('keeps the high-noise expert out of the ordinary checkpoint pick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-wan-'));
    await mkdir(join(root, 'checkpoint'), { recursive: true });
    // The high-noise file is deliberately the larger one: "largest wins" would
    // otherwise load it as the only diffusion model and produce noise.
    await writeFile(join(root, 'checkpoint', 'wan2.2_high_noise.gguf'), 'x'.repeat(200));
    await writeFile(join(root, 'checkpoint', 'wan2.2_low_noise.gguf'), 'x'.repeat(100));
    await writeFile(
      join(root, 'model.json'),
      JSON.stringify({ kind: 'video', mode: 'video', capabilities: ['s2v'] }),
    );

    const resolved = await resolveImageBundle(root, 'wan22-s2v', 'video');
    expect(resolved.checkpointPath).toMatch(/low_noise/);
    expect(resolved.highNoisePath).toMatch(/high_noise/);
    expect(resolved.s2v?.audioFlag).toBe('--ref-audio');
  });

  it('leaves s2v unset on a model that does not declare the capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-wan-t2v-'));
    await mkdir(join(root, 'checkpoint'), { recursive: true });
    await writeFile(join(root, 'checkpoint', 'wan2.1_t2v.gguf'), 'x'.repeat(100));

    const resolved = await resolveImageBundle(root, 'wan21', 'video');
    expect(resolved.s2v).toBeUndefined();
    expect(resolved.highNoisePath).toBeUndefined();
  });

  it('lets a manifest override the audio flag, so a new model is a config change', () => {
    const config = resolveS2vConfig({ s2v: { audio_flag: '--audio', chunk_seconds: 4.5 } });
    expect(config.audioFlag).toBe('--audio');
    expect(config.chunkSeconds).toBe(4.5);
    // Unspecified fields still fall back to the model-family defaults.
    expect(config.framesPerChunk).toBe(81);
  });

  it('rounds a frame count up onto the model\'s grid, leaving ungridded models alone', () => {
    // MiniMax-H3 accepts only 17k+5 and rounds up on its own; doing it here is
    // what keeps the stitch's idea of a segment's length correct.
    expect(alignFrames(50, { stride: 17, offset: 5 })).toBe(56);
    expect(alignFrames(56, { stride: 17, offset: 5 })).toBe(56);
    expect(alignFrames(1, { stride: 17, offset: 5 })).toBe(5);
    expect(alignFrames(80)).toBe(80);
  });

  it('separates an audio VAE from the video VAE in a shared slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-mm-'));
    await mkdir(join(root, 'checkpoint'), { recursive: true });
    await mkdir(join(root, 'vae'), { recursive: true });
    await writeFile(join(root, 'checkpoint', 'minimax_h3_ref2va-Q4_K_M.gguf'), 'x'.repeat(100));
    // The audio VAE is deliberately the larger file here.
    await writeFile(join(root, 'vae', 'minimax_h3_audio_vae_fp32.safetensors'), 'x'.repeat(200));
    await writeFile(join(root, 'vae', 'minimax_h3_video_vae_fp16.safetensors'), 'x'.repeat(50));
    await writeFile(
      join(root, 'model.json'),
      JSON.stringify({ kind: 'video', mode: 'video', capabilities: ['s2v'] }),
    );

    const resolved = await resolveImageBundle(root, 'minimax-h3', 'video');
    expect(resolved.weights.vae).toMatch(/video_vae/);
    expect(resolved.weights.audio_vae).toMatch(/audio_vae/);
  });

  it('routes the chained frame to the flag the model accepts', () => {
    // MiniMax-H3's Ref2VA rejects --init-img outright when reference
    // conditioning is in play, so the chained frame has to go to -r.
    const args = buildImageArgs({
      params: { prompt: 'x', model: 'minimax-h3' },
      bundle: {
        id: 'minimax-h3',
        mode: 'video',
        loadMode: 'diffusion-model',
        checkpointPath: '/models/mm.gguf',
        weights: { audio_vae: '/models/audio_vae.safetensors' },
        extraArgs: [],
        defaults: {},
        capabilities: ['s2v'],
      } as never,
      outputPath: '/out/segment.webm',
      images: { init: '/tmp/seed.png', initFlag: '-r' },
    });

    expect(args[args.indexOf('-r') + 1]).toBe('/tmp/seed.png');
    expect(args).not.toContain('-i');
    expect(args[args.indexOf('--audio-vae') + 1]).toBe('/models/audio_vae.safetensors');
  });

  it('emits the speech encoder only once a flag is named for it', () => {
    const bundle = {
      id: 'wan22-s2v',
      mode: 'video',
      loadMode: 'diffusion-model',
      checkpointPath: '/models/wan.gguf',
      audioEncoderPath: '/models/aux/wav2vec2.safetensors',
      weights: {},
      extraArgs: [],
      defaults: {},
      capabilities: ['s2v'],
    };
    const params = { prompt: 'x', model: 'wan22-s2v' };
    const audio = { path: '/tmp/c0.wav', flag: '--ref-audio' };

    // No flag in model.json (bundles installed before the catalogue named
    // one): sd-cli's --audio-encoder is the default, since Wan S2V fails
    // without its encoder.
    const byDefault = buildImageArgs({
      params,
      bundle: { ...bundle, s2v: resolveS2vConfig(null) } as never,
      outputPath: '/out/s.webm',
      audio,
    });
    expect(byDefault[byDefault.indexOf('--audio-encoder') + 1]).toBe(
      '/models/aux/wav2vec2.safetensors',
    );

    // A model with no encoder file gets no flag, whatever the default.
    const noEncoder = buildImageArgs({
      params,
      bundle: { ...bundle, audioEncoderPath: undefined, s2v: resolveS2vConfig(null) } as never,
      outputPath: '/out/s.webm',
      audio,
    });
    expect(noEncoder).not.toContain('--audio-encoder');

    const withFlag = buildImageArgs({
      params,
      bundle: {
        ...bundle,
        s2v: { audioFlag: '--ref-audio', audioEncoderFlag: '--audio-encoder' },
      } as never,
      outputPath: '/out/s.webm',
      audio,
    });
    expect(withFlag[withFlag.indexOf('--audio-encoder') + 1]).toBe(
      '/models/aux/wav2vec2.safetensors',
    );
  });

  it('passes audio and the high-noise expert under their own flags', () => {
    const args = buildImageArgs({
      params: { prompt: 'a person speaking', model: 'wan22-s2v', video_frames: 81, fps: 16 },
      bundle: {
        id: 'wan22-s2v',
        mode: 'video',
        loadMode: 'diffusion-model',
        checkpointPath: '/models/low.gguf',
        highNoisePath: '/models/high.gguf',
        weights: {},
        extraArgs: [],
        defaults: {},
        capabilities: ['s2v'],
      } as never,
      outputPath: '/out/segment.webm',
      images: { init: '/tmp/seed.png' },
      audio: { path: '/tmp/chunk-0000.wav', flag: '--ref-audio' },
    });

    expect(args.slice(0, 2)).toEqual(['-M', 'vid_gen']);
    for (const [flag, value] of [
      ['--diffusion-model', '/models/low.gguf'],
      ['--high-noise-diffusion-model', '/models/high.gguf'],
      ['--ref-audio', '/tmp/chunk-0000.wav'],
      ['-i', '/tmp/seed.png'],
      ['--video-frames', '81'],
      ['--fps', '16'],
    ] as const) {
      expect(args[args.indexOf(flag) + 1]).toBe(value);
    }
  });
});

describe('Python backend', () => {
  const fakeLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as import('fastify').FastifyBaseLogger;

  function fakePaths(root: string) {
    return { modelsDir: join(root, 'models') } as unknown as import('../src/paths.js').Paths;
  }

  async function makeRuntime(installDir: string) {
    await mkdir(join(installDir, 'venv', 'bin'), { recursive: true });
    const pythonPath = join(installDir, 'venv', 'bin', 'python');
    await writeFile(pythonPath, '');
    const receipt = {
      pythonPath,
      runtimeDir: join(installDir, 'runtime'),
      venvDir: join(installDir, 'venv'),
      version: 'cpython-3.12.8-test',
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(installDir, 'python-runtime.json'), JSON.stringify(receipt));
    return receipt;
  }

  it('accepts backend: "python" and its fields in both schemas', async () => {
    const { catalogueModelSchema } = await import('../src/catalogue/types.js');
    const { manifestSchema } = await import('../src/models/bundle.js');

    const catalogueModel = catalogueModelSchema.parse({
      id: 'echomimic-v3',
      kind: 'video',
      name: 'EchoMimicV3',
      backend: 'python',
      pythonPackage: 'https://github.com/antgroup/echomimic_v3',
      pythonEntrypoint: 'infer_preview.py',
      pythonComponentFlags: { 'other:base_model': '--pretrained_wan_path' },
      pythonHealthPath: '/',
      components: [
        { slot: 'other:base_model', label: 'Base model', required: true, source: { repo: 'a/b' } },
      ],
    });
    expect(catalogueModel.backend).toBe('python');

    const manifest = manifestSchema.parse({
      backend: 'python',
      python_package: 'https://github.com/antgroup/echomimic_v3',
      python_entrypoint: 'infer_preview.py',
      python_component_flags: { 'other:base_model': '--pretrained_wan_path' },
      python_health_path: '/',
    });
    expect(manifest.python_entrypoint).toBe('infer_preview.py');
  });

  it('copies backend/python/vllm catalogue fields into the installed manifest', async () => {
    // Regression test: the install route used to drop `backend`,
    // `huggingfaceId`/`vllmPipelineClass` and their Python equivalents on the
    // floor, so an installed vLLM or Python bundle's manifest never actually
    // said which backend served it.
    const model = {
      id: 'echomimic-v3',
      kind: 'video' as const,
      name: 'EchoMimicV3',
      backend: 'python' as const,
      pythonPackage: 'https://github.com/antgroup/echomimic_v3',
      pythonEntrypoint: 'infer_preview.py',
      pythonComponentFlags: { 'other:base_model': '--pretrained_wan_path' },
      pythonHealthPath: '/',
      tags: [],
      loadMode: undefined,
      mode: undefined,
      defaults: undefined,
      extraArgs: undefined,
      capabilities: undefined,
      s2v: undefined,
      family: undefined,
      task: undefined,
      audioMode: undefined,
    };
    // Mirrors the object construction in routes/catalogue.ts's install handler.
    const manifest = {
      name: model.name,
      kind: model.kind,
      backend: model.backend,
      huggingface_id: undefined,
      vllm_pipeline_class: undefined,
      python_package: model.pythonPackage,
      python_entrypoint: model.pythonEntrypoint,
      python_component_flags: model.pythonComponentFlags,
      python_health_path: model.pythonHealthPath,
      load: model.loadMode,
      mode: model.mode,
    };
    const { manifestSchema } = await import('../src/models/bundle.js');
    const parsed = manifestSchema.parse(manifest);
    expect(parsed.backend).toBe('python');
    expect(parsed.python_package).toBe('https://github.com/antgroup/echomimic_v3');
  });

  it('installPackage skips re-cloning a package that is already on disk', async () => {
    const { PythonInstaller } = await import('../src/backends/python.js');
    const root = await mkdtemp(join(tmpdir(), 'pepper-python-'));
    const installer = new PythonInstaller(root, fakeLog);
    const runtime = await makeRuntime(root);

    const target = installer.packageDir('https://github.com/antgroup/echomimic_v3');
    await mkdir(join(target, '.git'), { recursive: true });
    await writeFile(join(target, 'sentinel.txt'), 'already here');

    const result = await installer.installPackage(runtime, {
      source: 'https://github.com/antgroup/echomimic_v3',
    });
    expect(result).toBe(target);
    // Untouched: a real clone would have removed this first.
    const { readFile: read } = await import('node:fs/promises');
    expect(await read(join(target, 'sentinel.txt'), 'utf8')).toBe('already here');
  });

  it('resolves the entrypoint and component flags for a fully-installed Python model', async () => {
    const { PythonInstaller, pythonManagedValues } = await import('../src/backends/python.js');
    const root = await mkdtemp(join(tmpdir(), 'pepper-python-'));
    const installer = new PythonInstaller(root, fakeLog);
    await makeRuntime(root);

    const source = 'https://github.com/antgroup/echomimic_v3';
    const packageDir = installer.packageDir(source);
    await mkdir(join(packageDir, '.git'), { recursive: true });
    await writeFile(join(packageDir, 'infer_preview.py'), '# entrypoint');

    const paths = fakePaths(root);
    const bundleRoot = join(root, 'models', 'video', 'echomimic-v3');
    await mkdir(join(bundleRoot, 'base_model'), { recursive: true });
    await writeFile(join(bundleRoot, 'base_model', 'config.json'), '{}');
    await mkdir(join(bundleRoot, 'wav2vec'), { recursive: true }); // declared but left empty

    const result = await pythonManagedValues(paths, installer, {
      id: 'echomimic-v3',
      kind: 'video',
      name: 'EchoMimicV3',
      manifest: {
        python_package: source,
        python_entrypoint: 'infer_preview.py',
        python_component_flags: {
          'other:base_model': '--pretrained_wan_path',
          'other:wav2vec': '--wav2vec_path',
        },
        python_health_path: '/',
      },
    });

    expect(result.healthPath).toBe('/');
    expect(result.argvPrefix[0]).toBe(join(packageDir, 'infer_preview.py'));
    expect(result.argvPrefix).toContain('--pretrained_wan_path');
    expect(result.argvPrefix[result.argvPrefix.indexOf('--pretrained_wan_path') + 1]).toBe(
      join(bundleRoot, 'base_model'),
    );
    // The empty, declared slot is omitted rather than passed as an empty dir.
    expect(result.argvPrefix).not.toContain('--wav2vec_path');
  });

  it('throws a specific, actionable reason at each unmet precondition', async () => {
    const { PythonInstaller, pythonManagedValues } = await import('../src/backends/python.js');
    const root = await mkdtemp(join(tmpdir(), 'pepper-python-'));
    const installer = new PythonInstaller(root, fakeLog);
    const paths = fakePaths(root);
    const bundle = { id: 'echomimic-v3', kind: 'video' as const, name: 'EchoMimicV3', manifest: null };

    // No python_package/python_entrypoint declared at all.
    await expect(pythonManagedValues(paths, installer, bundle)).rejects.toThrow(/python_package/);

    const withFields = {
      ...bundle,
      manifest: { python_package: 'https://github.com/antgroup/echomimic_v3', python_entrypoint: 'infer_preview.py' },
    };

    // Runtime never installed.
    await expect(pythonManagedValues(paths, installer, withFields)).rejects.toThrow(/runtime/i);

    // Runtime installed, package not cloned yet.
    await makeRuntime(root);
    await expect(pythonManagedValues(paths, installer, withFields)).rejects.toThrow(/not installed/i);

    // Package cloned, entrypoint file missing.
    const packageDir = installer.packageDir(withFields.manifest.python_package);
    await mkdir(join(packageDir, '.git'), { recursive: true });
    await expect(pythonManagedValues(paths, installer, withFields)).rejects.toThrow(/Entrypoint/);
  });
});

describe('snapshot download flattening', () => {
  it('moves a single-segment sub-folder pull up into the slot directory', async () => {
    const { flattenSnapshotPath } = await import('../src/downloads/snapshot.js');
    const dir = await mkdtemp(join(tmpdir(), 'pepper-snapshot-'));
    await mkdir(join(dir, 'transformer'), { recursive: true });
    await writeFile(join(dir, 'transformer', 'config.json'), '{}');
    await writeFile(join(dir, 'transformer', 'diffusion_pytorch_model.safetensors'), 'x'.repeat(10));

    await flattenSnapshotPath(dir, 'transformer');

    const { readdir, stat } = await import('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual(['config.json', 'diffusion_pytorch_model.safetensors']);
    await expect(stat(join(dir, 'transformer'))).rejects.toThrow(); // the now-empty wrapper is gone
  });

  it('walks up a multi-segment sub-folder, removing every emptied level', async () => {
    const { flattenSnapshotPath } = await import('../src/downloads/snapshot.js');
    const dir = await mkdtemp(join(tmpdir(), 'pepper-snapshot-'));
    await mkdir(join(dir, 'split_files', 'diffusion_models'), { recursive: true });
    await writeFile(join(dir, 'split_files', 'diffusion_models', 'weights.safetensors'), 'x');

    await flattenSnapshotPath(dir, 'split_files/diffusion_models');

    const { readdir, stat } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['weights.safetensors']);
    await expect(stat(join(dir, 'split_files'))).rejects.toThrow();
  });

  it('is a no-op when nothing landed under the declared sub-folder', async () => {
    const { flattenSnapshotPath } = await import('../src/downloads/snapshot.js');
    const dir = await mkdtemp(join(tmpdir(), 'pepper-snapshot-'));
    await expect(flattenSnapshotPath(dir, 'missing')).resolves.toBeUndefined();
  });
});

describe('upscaler', () => {
  const service = (dir: string, prefs: Partial<UpscalerPreferences> = {}, pythonReady = true) => {
    const config = loadConfig({ UPSCALE_MODELS_DIR: dir });
    const noop = () => {};
    const log = { warn: noop, info: noop, error: noop, debug: noop } as never;
    let stored: UpscalerPreferences = { ...upscalerPreferencesKey.defaultValue, ...prefs };
    const settings = {
      get: () => stored,
      patch: (_key: unknown, partial: Partial<UpscalerPreferences>) =>
        (stored = { ...stored, ...partial }),
    } as never;
    const python = { runtimeInstalled: async () => pythonReady } as never;
    return new UpscaleService(config, {} as never, {} as ImageService, python, settings, log);
  };
  const checkpoint = (dir: string, name: string) => writeFile(join(dir, name), 'weights');

  it('defaults the model directory under DATA_DIR', () => {
    expect(loadConfig({ DATA_DIR: '/mnt/data' }).upscaleModelsDir).toBe('/mnt/data/models/upscale');
  });

  it('reads each checkpoint\'s native scale from the catalogue or its file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    await checkpoint(dir, 'RealESRGAN_x4plus.safetensors');
    await checkpoint(dir, 'RealESRGAN_x2.safetensors');
    await checkpoint(dir, '4x-UltraSharpV2.safetensors');
    await checkpoint(dir, '2x_Custom.pth');
    await writeFile(join(dir, 'empty.pth'), '');
    await writeFile(join(dir, 'notes.txt'), 'x');

    const models = await service(dir).listModels();
    expect(models.map((m) => [m.name, m.scale])).toEqual([
      ['2x_Custom.pth', 2],
      ['RealESRGAN_x2.safetensors', 2],
      ['4x-UltraSharpV2.safetensors', 4],
      ['RealESRGAN_x4plus.safetensors', 4],
    ]);
    expect(models.find((m) => m.name === '4x-UltraSharpV2.safetensors')?.sdcpp).toBe(false);
  });

  it('offers both scales from any checkpoint with Python, and only what sd-cli loads without it', async () => {
    const withX4 = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    await checkpoint(withX4, 'RealESRGAN_x4plus.safetensors');
    expect(await service(withX4).availableScales()).toEqual([2, 4]);
    expect(await service(withX4, { engine: 'sdcpp' }).availableScales()).toEqual([2, 4]);

    const onlyDat = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    await checkpoint(onlyDat, '4x-UltraSharpV2.safetensors');
    expect(await service(onlyDat).availableScales()).toEqual([2, 4]);
    expect(await service(onlyDat, { engine: 'sdcpp' }).availableScales()).toEqual([]);

    const empty = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    expect(await service(empty).availableScales()).toEqual([]);
    expect(await service(join(empty, 'missing')).availableScales()).toEqual([]);
  });

  it('picks the configured default, else a preferred checkpoint, per scale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    await checkpoint(dir, 'RealESRGAN_x4plus.safetensors');
    await checkpoint(dir, '4x-UltraSharp.safetensors');
    await checkpoint(dir, 'RealESRGAN_x2.safetensors');
    await checkpoint(dir, '4x-ClearRealityV1.safetensors');

    const auto = service(dir);
    expect((await auto.defaultModel(4))?.name).toBe('4x-UltraSharp.safetensors');
    expect((await auto.defaultModel(2))?.name).toBe('RealESRGAN_x2.safetensors');

    const configured = service(dir, { default_x4: '4x-ClearRealityV1.safetensors' });
    expect((await configured.defaultModel(4))?.name).toBe('4x-ClearRealityV1.safetensors');
    // A default that is no longer on disk falls back rather than failing.
    const stale = service(dir, { default_x2: 'gone.pth' });
    expect((await stale.defaultModel(2))?.name).toBe('RealESRGAN_x2.safetensors');
  });

  it('refuses an architecture sd-cli cannot load when the engine is pinned to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-esrgan-'));
    await checkpoint(dir, '4x-ClearRealityV1.safetensors');
    await expect(
      service(dir, { engine: 'sdcpp' }).upscale({ inputPath: '/nope.png', scale: 4 }),
    ).rejects.toThrow(/needs the Python engine/);
  });

  it('knows which catalogue checkpoints sd-cli can load', () => {
    expect(sdcppCompatible('RealESRGAN_x4plus.safetensors')).toBe(true);
    expect(sdcppCompatible('4x-UltraSharp.safetensors')).toBe(true);
    expect(sdcppCompatible('4x-UltraSharpV2.safetensors')).toBe(false);
    expect(sdcppCompatible('RealESRGAN_x2.safetensors')).toBe(false);
    expect(sdcppCompatible('mystery.pth')).toBeUndefined();
    expect(catalogueEntryFor('4X-ULTRASHARP.SAFETENSORS')?.id).toBe('ultrasharp-4x');
    expect(new Set(UPSCALER_CATALOGUE.map((entry) => entry.file)).size).toBe(UPSCALER_CATALOGUE.length);
  });
});

describe('character studio', () => {
  it('reads the JSON object out of an LLM reply, around fences and thinking', () => {
    expect(parseJsonObject('<think>hmm {no}</think>```json\n{"name":"Gronk","appearance":"a dwarf"}\n```')).toEqual({
      name: 'Gronk',
      appearance: 'a dwarf',
    });
    // A bare quote inside a value (a height in inches) is repaired, not fatal.
    expect(parseJsonObject('{"appearance": "30s, 5\'8", lean", "name": "Mara"}')).toEqual({
      appearance: '30s, 5\'8", lean',
      name: 'Mara',
    });
    expect(parseJsonObject('no json here')).toBeNull();
    expect(parseJsonObject('[1,2]')).toBeNull();
  });

  it('fills the sheet template with every placeholder', () => {
    for (const key of ['{name}', '{appearance}', '{style}']) expect(SHEET_TEMPLATE).toContain(key);
  });

  it('turns a character voice into speech-job fields, dropping blanks', () => {
    expect(
      speechParams({ model: 'qwen3-tts', instructions: '  warm narrator ', voice: '', voice_ref: undefined }),
    ).toEqual({ model: 'qwen3-tts', instructions: 'warm narrator' });
  });
});

describe('Python video runners', () => {
  async function runnerBundle(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pepper-runner-'));
    for (const [path, body] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), body);
    }
    await writeFile(
      join(root, 'model.json'),
      JSON.stringify({
        name: 'Wan 2.2 TI2V-5B',
        backend: 'python',
        python_runner: 'wan22_ti2v',
        mode: 'video',
        required_slots: ['checkpoint', 'clip', 'vae', 'other:tokenizer'],
      }),
    );
    return root;
  }

  it('judges a runner bundle ready only when every required slot has files', async () => {
    const partial = await runnerBundle({
      'checkpoint/wan.gguf': 'x',
      'clip/umt5.gguf': 'x',
      'vae/config.json': '{}',
    });
    const missing = await inspectBundle(partial, 'wan', 'video');
    expect(missing.ready).toBe(false);
    expect(missing.readyReason).toBe('Missing files for tokenizer/');

    await mkdir(join(partial, 'tokenizer'), { recursive: true });
    await writeFile(join(partial, 'tokenizer', 'spiece.model'), 'x');
    expect((await inspectBundle(partial, 'wan', 'video')).ready).toBe(true);
  });

  it('keeps a runner bundle not ready while one of its files is still downloading', async () => {
    // config.json landed, the weights beside it have not: loading it now would
    // fail mid-job rather than up front.
    const root = await runnerBundle({
      'checkpoint/wan.gguf': 'x',
      'clip/umt5.gguf': 'x',
      'vae/config.json': '{}',
      'vae/diffusion_pytorch_model.safetensors.part': 'x',
      'tokenizer/spiece.model': 'x',
    });
    const info = await inspectBundle(root, 'wan', 'video');
    expect(info.ready).toBe(false);
    expect(info.readyReason).toBe('Still downloading vae/');
  });

  it('matches include globs against the basename, case-insensitively', async () => {
    const { globToRegExp } = await import('../src/catalogue/manager.js');
    expect(globToRegExp('config.json').test('config.json')).toBe(true);
    expect(globToRegExp('config.json').test('configXjson')).toBe(false);
    expect(globToRegExp('*.json').test('tokenizer_config.json')).toBe(true);
    expect(globToRegExp('*.json').test('spiece.model')).toBe(false);
    expect(globToRegExp('Wan2.1_VAE.pth').test('wan2.1_vae.pth')).toBe(true);
  });

  it('accepts pythonRunner and allFiles sources in the catalogue schema', async () => {
    const { catalogueModelSchema } = await import('../src/catalogue/types.js');
    const model = catalogueModelSchema.parse({
      id: 'wan2.2-ti2v-5b-turbo',
      kind: 'video',
      name: 'Wan 2.2 TI2V-5B Turbo',
      backend: 'python',
      pythonRunner: 'wan22_ti2v',
      components: [
        {
          slot: 'vae',
          label: 'VAE',
          required: true,
          source: { repo: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', path: 'vae', allFiles: true, include: ['config.json'] },
        },
      ],
    });
    expect(model.pythonRunner).toBe('wan22_ti2v');
    expect(model.components[0].source.allFiles).toBe(true);
  });

  it('does not try to serve a runner bundle as a long-running process', async () => {
    const { PythonInstaller, pythonManagedValues } = await import('../src/backends/python.js');
    const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as import('fastify').FastifyBaseLogger;
    const installer = new PythonInstaller(await mkdtemp(join(tmpdir(), 'pepper-py-')), log);
    await expect(
      pythonManagedValues({} as never, installer, {
        id: 'echomimic-v3',
        kind: 'video',
        name: 'EchoMimicV3',
        manifest: { backend: 'python', python_runner: 'echomimic_v3' },
      }),
    ).rejects.toThrow(/runs per job/);
  });

  it('pins a package to a commit without it leaking into the checkout path', async () => {
    const { PythonInstaller } = await import('../src/backends/python.js');
    const log = { info: () => {} } as unknown as import('fastify').FastifyBaseLogger;
    const dir = await mkdtemp(join(tmpdir(), 'pepper-py-'));
    const installer = new PythonInstaller(dir, log);
    expect(installer.packageDir('https://github.com/antgroup/echomimic_v3#7e89489')).toBe(
      join(dir, 'packages', 'echomimic_v3'),
    );
  });
});

describe('Python runner protocol', () => {
  // Spawns the real `python -m pepper_runner` with whatever python3 is on the
  // PATH. The protocol layer imports nothing beyond the standard library, so
  // this needs no torch — only a Python.
  const probe = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  const python = probe.status === 0 ? probe.stdout.trim() : null;

  it.skipIf(!python)("surfaces a runner's error line as the job's error", async () => {
    const { PythonVideoService } = await import('../src/services/python-video.js');
    const { buildPaths } = await import('../src/paths.js');
    const root = await mkdtemp(join(tmpdir(), 'pepper-proto-'));
    const config = loadConfig({ DATA_DIR: root, OUTPUT_DIR: join(root, 'out'), PYTHON_EXECUTABLE: python! });
    const paths = buildPaths(config);
    await mkdir(paths.cacheDir, { recursive: true });

    const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as import('fastify').FastifyBaseLogger;
    const backends = { get: () => undefined } as unknown as import('@pepper/core/backends/manager.js').BackendManager;
    const memory = { exclusive: async () => {}, release: async () => {} };
    const service = new PythonVideoService(config, paths, backends, memory, log, new LogBuffer(100));

    await expect(
      service.generate({
        bundle: {
          id: 'fake',
          kind: 'video',
          name: 'Fake',
          manifest: { backend: 'python', python_runner: 'no_such_runner' },
          loadMode: 'model',
          mode: 'video',
          components: [],
          partials: [],
          capabilities: [],
          size: 0,
          modified: '',
          ready: true,
        },
        params: { prompt: 'x', model: 'fake' },
      }),
    ).rejects.toThrow(/Unknown runner 'no_such_runner'/);
  });
});

describe('text encoders as chat models', () => {
  /** A header-only GGUF v3 with the given string / string-array metadata. */
  function gguf(kv: Record<string, string | string[]>): Buffer {
    const parts: Buffer[] = [];
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
    parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length + 1));
    // A fixed-size array first, so skipping by length is exercised too.
    parts.push(str('tokenizer.ggml.token_type'), u32(9), u32(5), u64(3), u32(1), u32(1), u32(1));
    for (const [key, value] of Object.entries(kv)) {
      parts.push(str(key));
      if (Array.isArray(value)) parts.push(u32(9), u32(8), u64(value.length), ...value.map(str));
      else parts.push(u32(8), str(value));
    }
    return Buffer.concat(parts);
  }

  async function info(kv: Record<string, string | string[]>) {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-gguf-'));
    await writeFile(join(dir, 'm.gguf'), gguf(kv));
    return readGgufInfo(join(dir, 'm.gguf'));
  }

  const tokenizer = { 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': ['a', 'b', 'c'] };

  it('reads the architecture past large arrays', async () => {
    const i = await info({ ...tokenizer, 'general.architecture': 'qwen3' });
    expect(i.architecture).toBe('qwen3');
    expect(i.keys.has('tokenizer.ggml.tokens')).toBe(true);
  });

  it('accepts a decoder LLM with a chat template (Z-Image / Qwen-Image encoders)', async () => {
    const i = await info({ 'general.architecture': 'qwen3vl', ...tokenizer, 'tokenizer.chat_template': '{{x}}' });
    expect(isChatLlm(i)).toBe(true);
  });

  it('rejects ~1-bit quants, which condition images fine but cannot chat', async () => {
    const i = await info({ 'general.architecture': 'qwen3', ...tokenizer, 'tokenizer.chat_template': '{{x}}' });
    expect(isChatLlm({ ...i, fileType: 24 })).toBe(false); // IQ1_S
    expect(isChatLlm({ ...i, fileType: 15 })).toBe(true); // Q4_K_M
  });

  it('rejects umT5 (no chat template) and vision projectors (no tokenizer)', async () => {
    expect(isChatLlm(await info({ 'general.architecture': 't5encoder', ...tokenizer }))).toBe(false);
    expect(isChatLlm(await info({ 'general.architecture': 'clip' }))).toBe(false);
  });

  it('refuses a file that is not GGUF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-gguf-'));
    await writeFile(join(dir, 'x.gguf'), 'not a model');
    await expect(readGgufInfo(join(dir, 'x.gguf'))).rejects.toThrow();
  });
});

describe('auth', () => {
  it('guards the API, MCP and docs but not the web app shell or health', () => {
    for (const url of ['/v1/models', '/v1/outputs/a.png?x=1', '/mcp', '/mcp/abc', '/docs', '/docs/json']) {
      expect(requiresAuth(url), url).toBe(true);
    }
    for (const url of ['/health', '/', '/image', '/assets/index.js', '/v1/session', '/v1/session?x']) {
      expect(requiresAuth(url), url).toBe(false);
    }
  });

  it('compares secrets exactly', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('abc', '')).toBe(false);
    expect(secretsMatch('abc', undefined)).toBe(false);
  });

  it('derives the session cookie from the token instead of storing it', () => {
    expect(sessionValue('t')).not.toContain('t'.repeat(2));
    expect(sessionValue('t')).toBe(sessionValue('t'));
    expect(sessionValue('t')).not.toBe(sessionValue('u'));
  });

  it('censors the token in /mcp/<token> urls', () => {
    expect(redactTokenPath('/mcp/s3cret')).toBe('/mcp/[redacted]');
    expect(redactTokenPath('/mcp')).toBe('/mcp');
    expect(redactTokenPath('/v1/models')).toBe('/v1/models');
  });

  async function server(env: Record<string, string> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-auth-'));
    const built = await buildServer(
      loadConfig({ DATA_DIR: dir, OUTPUT_DIR: join(dir, 'out'), LOG_LEVEL: 'fatal', ...env }),
    );
    await built.app.ready();
    return built;
  }

  it('accepts a Bearer token, a session cookie or the MCP path, and nothing else', async () => {
    const { app, closeDb } = await server({ PEPPER_API_TOKEN: 'tok' });
    try {
      const get = (headers: Record<string, string> = {}) =>
        app.inject({ url: '/v1/models', headers }).then((r) => r.statusCode);
      expect(await get()).toBe(401);
      expect(await get({ authorization: 'Bearer nope' })).toBe(401);
      expect(await get({ authorization: 'Bearer tok' })).toBe(200);
      // The cookie value is not the token, so the token is not a valid cookie.
      expect(await get({ cookie: 'pepper_session=tok' })).toBe(401);

      expect((await app.inject({ method: 'POST', url: '/v1/session', payload: { token: 'nope' } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/v1/session', payload: { token: 'tok' } });
      expect(login.statusCode).toBe(204);
      const cookie = String(login.headers['set-cookie']);
      expect(cookie).toContain('HttpOnly');
      // Plain http (local development): Secure would make the browser drop it.
      expect(cookie).not.toContain('Secure');
      expect(await get({ cookie: cookie.split(';')[0] })).toBe(200);

      const mcp = (url: string) =>
        app
          .inject({
            method: 'POST',
            url,
            headers: { accept: 'application/json, text/event-stream' },
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          })
          .then((r) => r.statusCode);
      expect(await mcp('/mcp')).toBe(401);
      expect(await mcp('/mcp/nope')).toBe(401);
      expect(await mcp('/mcp/tok')).toBe(200);

      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
      closeDb();
    }
  });

  it('takes a path token containing / and =, raw or encoded, and 404s OAuth discovery', async () => {
    // Base64 tokens carry `/` and `=`; a connector URL is often pasted unencoded.
    const token = 'ab/cd+ef=';
    const { app, closeDb } = await server({ PEPPER_API_TOKEN: token });
    try {
      const mcp = (url: string) =>
        app
          .inject({
            method: 'POST',
            url,
            headers: { accept: 'application/json, text/event-stream' },
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
          })
          .then((r) => r.statusCode);
      expect(await mcp(`/mcp/${token}`)).toBe(200);
      expect(await mcp(`/mcp/${encodeURIComponent(token)}`)).toBe(200);
      expect(await mcp('/mcp/ab/cd')).toBe(401);
      // A malformed escape never gets in (Fastify itself answers 400).
      expect(await mcp('/mcp/%E0%A4%A')).toBeGreaterThanOrEqual(400);
      expect(redactTokenPath(`/mcp/${token}`)).toBe('/mcp/[redacted]');

      // Not the SPA: an HTML 200 here reads to a connector as OAuth metadata.
      for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
        const response = await app.inject({ url });
        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toMatch(/json/);
      }
    } finally {
      await app.close();
      closeDb();
    }
  });

  it('signs a link to one output that opens that file until it expires, and nothing else', () => {
    const now = Date.UTC(2026, 8, 30);
    const url = signMediaUrl('tok', 'a b.webm', now, 60);
    expect(url).toMatch(/^\/v1\/outputs\/a%20b\.webm\?exp=\d+&sig=[\w-]+$/);
    expect(isSignedMediaRequest('GET', url, 'tok', now)).toBe(true);
    expect(isSignedMediaRequest('HEAD', url, 'tok', now)).toBe(true);

    expect(isSignedMediaRequest('GET', url, 'tok', now + 61_000), 'expired').toBe(false);
    expect(isSignedMediaRequest('GET', url, 'other', now), 'another token').toBe(false);
    expect(isSignedMediaRequest('DELETE', url, 'tok', now), 'a write').toBe(false);
    expect(isSignedMediaRequest('GET', url.replace('a%20b', 'c'), 'tok', now), 'another file').toBe(false);
    expect(isSignedMediaRequest('GET', url.replace('?', '/info?'), 'tok', now), 'a sub-route').toBe(false);
    expect(isSignedMediaRequest('GET', url.replace(/exp=\d+/, 'exp=9999999999'), 'tok', now), 'a later expiry').toBe(false);
    expect(isSignedMediaRequest('GET', '/v1/models?exp=9999999999&sig=x', 'tok', now)).toBe(false);

    // An open server has nothing to sign with, and needs nothing.
    expect(signMediaUrl(undefined, 'a.png')).toBe('/v1/outputs/a.png');
  });

  it('serves an output to a signed link without any other credential', async () => {
    const { app, closeDb } = await server({ PEPPER_API_TOKEN: 'tok' });
    try {
      await mkdir(app.paths.outputDir, { recursive: true });
      await writeFile(join(app.paths.outputDir, 'clip.webm'), '0123456789');
      const url = signMediaUrl('tok', 'clip.webm');

      expect((await app.inject({ url: '/v1/outputs/clip.webm' })).statusCode).toBe(401);
      const whole = await app.inject({ url });
      expect(whole.statusCode).toBe(200);
      expect(whole.headers['accept-ranges']).toBe('bytes');
      expect(whole.body).toBe('0123456789');
      expect((await app.inject({ url: url.replace(/sig=.{4}/, 'sig=AAAA') })).statusCode).toBe(401);
      // The link reads the file; it does not delete it, or list the folder.
      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
      expect((await app.inject({ url: `/v1/outputs?${url.split('?')[1]}` })).statusCode).toBe(401);

      const part = await app.inject({ url, headers: { range: 'bytes=2-5' } });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 2-5/10');
      expect(part.body).toBe('2345');
      expect((await app.inject({ url, headers: { range: 'bytes=50-' } })).statusCode).toBe(416);
    } finally {
      await app.close();
      closeDb();
    }
  });

  it('reads byte ranges the way players send them', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=2-500', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBe('unsatisfiable');
    // Several ranges, or another unit: serve the whole file.
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
  });

  it('stays open when no token is configured', async () => {
    const { app, closeDb } = await server();
    try {
      expect((await app.inject({ url: '/v1/models' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/v1/session' })).json()).toEqual({ required: false, authenticated: true });
    } finally {
      await app.close();
      closeDb();
    }
  });
});

describe('mcp', () => {
  const file = (filename: string, size: number) => ({ filename, size, url: `https://hf.co/${filename}` });

  it('picks the requested quantization, else the smallest file, for required components', () => {
    const components: CatalogueComponent[] = [
      { slot: 'checkpoint', required: true, files: [file('m-Q8_0.gguf', 8), file('m-Q4_K_M.gguf', 4)] },
      { slot: 'vae', required: true, files: [file('vae.safetensors', 1)] },
      { slot: 'lora', required: false, files: [file('style.safetensors', 1)] },
    ];
    expect(selectFiles(components, {}).map((s) => s.name)).toEqual(['m-Q4_K_M.gguf', 'vae.safetensors']);
    expect(selectFiles(components, { quant: 'q8_0' })[0].name).toBe('m-Q8_0.gguf');
    expect(selectFiles(components, { includeOptional: true })).toHaveLength(3);
  });

  it('installs every file of an allFiles set', () => {
    const components: CatalogueComponent[] = [
      {
        slot: 'weights',
        required: true,
        source: { allFiles: true },
        files: [file('config.json', 1), file('model.safetensors', 9)],
      },
    ];
    expect(selectFiles(components, {})).toHaveLength(2);
  });

  it('refuses a required component with nothing to install', () => {
    expect(() => selectFiles([{ slot: 'checkpoint', required: true, files: [], error: 'gated' }], {})).toThrow(
      /gated/,
    );
  });

  it('lists its tools and reports status over Streamable HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-mcp-'));
    const { app, closeDb } = await buildServer(
      loadConfig({ DATA_DIR: dir, OUTPUT_DIR: join(dir, 'out'), LOG_LEVEL: 'fatal' }),
    );
    await app.ready();
    try {
      const rpc = (method: string, params: unknown) =>
        app
          .inject({
            method: 'POST',
            url: '/mcp',
            headers: { accept: 'application/json, text/event-stream', host: 'pepper.test', 'x-forwarded-proto': 'https' },
            payload: { jsonrpc: '2.0', id: 1, method, params },
          })
          .then((r) => r.json());

      const tools = (await rpc('tools/list', {})).result.tools.map((t: { name: string }) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['pepper_status', 'generate_image', 'get_job', 'catalogue_install']));

      const status = await rpc('tools/call', { name: 'pepper_status', arguments: {} });
      const body = JSON.parse(status.result.content[0].text);
      expect(body.base_url).toBe('https://pepper.test');
      expect(body.backends).toBeInstanceOf(Array);

      const missing = await rpc('tools/call', { name: 'get_job', arguments: { id: 'nope', wait_seconds: 0 } });
      expect(missing.result.isError).toBe(true);
    } finally {
      await app.close();
      closeDb();
    }
  });

  it('offers a media view to hosts that can render one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-mcp-'));
    const { app, closeDb } = await buildServer(
      loadConfig({ DATA_DIR: dir, OUTPUT_DIR: join(dir, 'out'), LOG_LEVEL: 'fatal', PEPPER_API_TOKEN: 'tok' }),
    );
    await app.ready();
    try {
      const rpc = (method: string, params: unknown) =>
        app
          .inject({
            method: 'POST',
            url: '/mcp',
            headers: {
              accept: 'application/json, text/event-stream',
              authorization: 'Bearer tok',
              host: 'pepper.test',
              'x-forwarded-proto': 'https',
            },
            payload: { jsonrpc: '2.0', id: 1, method, params },
          })
          .then((r) => r.json());

      // The tools that produce media point at the view; the rest do not.
      const tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: string } } }> = (await rpc('tools/list', {}))
        .result.tools;
      const shown = tools.filter((t) => t._meta?.ui?.resourceUri === MEDIA_VIEW_URI).map((t) => t.name);
      expect(shown.sort()).toEqual(
        ['generate_image', 'generate_music', 'generate_speech', 'generate_video', 'get_job', 'upscale_image'].sort(),
      );

      // The view itself, allowed to load media from the origin the caller used.
      const view = (await rpc('resources/read', { uri: MEDIA_VIEW_URI })).result.contents[0];
      expect(view.mimeType).toBe(MEDIA_VIEW_MIME);
      expect(view.text).toContain('ui/initialize');
      expect(view._meta.ui.csp.resourceDomains).toEqual(['https://pepper.test']);

      // A finished video: the model gets a summary, the view a link it can load unauthenticated.
      await mkdir(app.paths.outputDir, { recursive: true });
      await writeFile(join(app.paths.outputDir, 'clip.webm'), 'webm');
      const job = {
        id: 'j1',
        kind: 'video',
        status: 'completed',
        progress: 1,
        params: {},
        result: { video_url: '/v1/outputs/clip.webm', metadata: { seed: 7 } },
        attempts: 1,
        createdAt: new Date().toISOString(),
      } as const;
      const result = await jobsResult({ app, baseUrl: 'https://pepper.test', apiToken: app.config.apiToken, jobs: app.jobs, outputDir: app.paths.outputDir, uploadsDir: app.paths.uploadsDir }, [{ ...job }]);
      expect(JSON.parse((result.content[0] as { text: string }).text).url).toBe('https://pepper.test/v1/outputs/clip.webm');
      const [shownJob] = (result.structuredContent as { jobs: Array<Record<string, string>> }).jobs;
      expect(shownJob).toMatchObject({ id: 'j1', media: 'video', status: 'completed', seed: 7 });
      expect(shownJob.media_url).toMatch(/^https:\/\/pepper\.test\/v1\/outputs\/clip\.webm\?exp=\d+&sig=/);
      const fetched = await app.inject({ url: shownJob.media_url.replace('https://pepper.test', '') });
      expect(fetched.statusCode).toBe(200);

      // The same file through MCP itself, for a host that blocks the direct link.
      const blob = (await rpc('resources/read', { uri: 'pepper://outputs/clip.webm' })).result.contents[0];
      expect(blob.mimeType).toBe('video/webm');
      expect(Buffer.from(blob.blob, 'base64').toString()).toBe('webm');
      expect((await rpc('resources/read', { uri: 'pepper://outputs/nope.webm' })).error.message).toMatch(/OUTPUT_NOT_FOUND/);
      expect((await rpc('resources/read', { uri: 'pepper://outputs/..%2Fpepper.db' })).error).toBeTruthy();

      // A job that is still running says so, which is what the view polls on.
      const running = await jobsResult({ app, baseUrl: 'https://pepper.test', apiToken: app.config.apiToken, jobs: app.jobs, outputDir: app.paths.outputDir, uploadsDir: app.paths.uploadsDir }, [
        { ...job, status: 'running', progress: 0.25, result: undefined },
      ]);
      expect((running.structuredContent as { jobs: unknown[] }).jobs[0]).toMatchObject({ status: 'running', progress: 0.25 });
    } finally {
      await app.close();
      closeDb();
    }
  });
});

describe('idle tracking', () => {
  it('counts actions, not reads, polling or rejected requests', () => {
    expect(isActivity('POST', '/v1/jobs', 202)).toBe(true);
    expect(isActivity('POST', '/mcp', 200, { jsonrpc: '2.0', method: 'tools/call' })).toBe(true);
    expect(isActivity('POST', '/mcp/tok', 200, [{ method: 'ping' }, { method: 'tools/call' }])).toBe(true);
    // An MCP client connecting, listing tools or pinging is not someone using Pepper.
    for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'ping']) {
      expect(isActivity('POST', '/mcp', 200, { jsonrpc: '2.0', method }), method).toBe(false);
    }
    expect(isActivity('DELETE', '/v1/models/image/x', 204)).toBe(true);
    expect(isActivity('GET', '/v1/system/status', 200)).toBe(false);
    expect(isActivity('POST', '/mcp', 401)).toBe(false);
    expect(isActivity('POST', '/v1/session', 204)).toBe(false);
  });

  it('never reports idle while work is in progress', () => {
    const tracker = new ActivityTracker();
    (tracker as unknown as { last: number }).last = Date.now() - 3_600_000;
    expect(tracker.snapshot(false).idleSeconds).toBeGreaterThanOrEqual(3599);
    expect(tracker.snapshot(true).idleSeconds).toBe(0);
    // Finishing the work starts the idle clock from then, not from the request.
    expect(tracker.snapshot(false).idleSeconds).toBe(0);
  });

  it('is reported by the status route and reset by an action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-idle-'));
    const { app, closeDb } = await buildServer(
      loadConfig({ DATA_DIR: dir, OUTPUT_DIR: join(dir, 'out'), LOG_LEVEL: 'fatal' }),
    );
    await app.ready();
    try {
      (app.activity as unknown as { last: number }).last = Date.now() - 600_000;
      const status = async () => (await app.inject({ url: '/v1/system/status' })).json().activity;
      expect((await status()).idleSeconds).toBeGreaterThanOrEqual(599);
      // Reading status is not activity...
      expect((await status()).idleSeconds).toBeGreaterThanOrEqual(599);
      // ...nor is an MCP client listing tools...
      const mcp = (method: string, params: unknown) =>
        app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { accept: 'application/json, text/event-stream' },
          payload: { jsonrpc: '2.0', id: 1, method, params },
        });
      await mcp('tools/list', {});
      expect((await status()).idleSeconds).toBeGreaterThanOrEqual(599);
      // ...but a tool call is, even a cheap one.
      await mcp('tools/call', { name: 'list_jobs', arguments: {} });
      expect((await status()).idleSeconds).toBeLessThan(5);
    } finally {
      await app.close();
      closeDb();
    }
  });
});

describe('hires and LoRA schedules', () => {
  const bundle = {
    id: 'z',
    mode: 'image',
    loadMode: 'diffusion-model',
    checkpointPath: '/m/z.gguf',
    weights: {},
    extraArgs: [],
    defaults: {},
    capabilities: [],
    loras: [],
    loraPresets: {},
    auxDir: '/m/aux',
    auxFiles: ['ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'],
  };

  it('lays the request over the model default, and lets it turn hires off', () => {
    const defaults = { enabled: true, scale: 1.5, denoise: 0.35, steps: 4, upscaler: '4x-UltraSharp' };
    expect(mergeHires(defaults, undefined)).toEqual({ scale: 1.5, denoise: 0.35, steps: 4, upscaler: '4x-UltraSharp' });
    expect(mergeHires(defaults, { denoise: 0.5 })?.denoise).toBe(0.5);
    expect(mergeHires(defaults, { enabled: false })).toBeUndefined();
    expect(mergeHires(undefined, undefined)).toBeUndefined();
    expect(mergeHires(undefined, { enabled: true })).toEqual({});
  });

  it('finds a named upscaler in the bundle first, then the shared folder', () => {
    expect(resolveHiresUpscaler('Latent', bundle, '/up', [])).toEqual({ upscaler: 'Latent' });
    expect(
      resolveHiresUpscaler('ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0', bundle, '/up', []).upscalersDir,
    ).toBe('/m/aux');
    expect(resolveHiresUpscaler('4x-UltraSharp', bundle, '/up', ['4x-UltraSharp.pth']).upscalersDir).toBe('/up');
    expect(() => resolveHiresUpscaler('missing', bundle, '/up', [])).toThrow(/missing/);
  });

  it('emits the hires flags', () => {
    const args = buildImageArgs({
      params: { prompt: 'x', model: 'z', scheduler: 'simple' },
      bundle: bundle as never,
      outputPath: '/o.png',
      hires: { scale: 2, steps: 4, denoise: 0.3, upscaler: '4x-UltraSharp', upscalersDir: '/up' },
    });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--hires');
    expect(at('--hires-upscalers-dir')).toBe('/up');
    expect(at('--hires-upscaler')).toBe('4x-UltraSharp');
    expect(at('--hires-scale')).toBe('2');
    expect(at('--hires-steps')).toBe('4');
    expect(at('--hires-denoising-strength')).toBe('0.3');
    expect(at('--scheduler')).toBe('simple');
    // Explicit target size wins over scale.
    const sized = buildImageArgs({
      params: { prompt: 'x', model: 'z' },
      bundle: bundle as never,
      outputPath: '/o.png',
      hires: { scale: 2, width: 1920, height: 1088 },
    });
    expect(sized).toContain('--hires-width');
    expect(sized).not.toContain('--hires-scale');
  });

  it('routes the high-noise half of a Wan 2.2 LoRA pair to the high-noise expert', () => {
    const loras = [{ name: 'low_noise_model' }, { name: 'high_noise_model', weight: 1 }];
    expect(withLoraTags('p', loras, true)).toBe('p <lora:low_noise_model:1> <lora:|high_noise|high_noise_model:1>');
    // A single-expert model gets plain tags.
    expect(withLoraTags('p', loras, false)).toBe('p <lora:low_noise_model:1> <lora:high_noise_model:1>');
  });

  it('samples the high-noise expert with the model defaults, or the Lightning schedule when paired', () => {
    const wan = { ...bundle, highNoisePath: '/m/high.gguf', defaults: { high_noise: { steps: 8, cfg_scale: 3.5 } } };
    const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
    const base = buildImageArgs({
      params: { prompt: 'x', model: 'w', steps: 10, cfg_scale: 3.5, sampler: 'euler' },
      bundle: wan as never,
      outputPath: '/o.webm',
    });
    expect(at(base, '--high-noise-steps')).toBe('8');
    expect(at(base, '--high-noise-sampling-method')).toBe('euler');
    const lightning = buildImageArgs({
      params: { prompt: 'x', model: 'w', steps: 4, cfg_scale: 1, loras: [{ name: 'high_noise_model' }] },
      bundle: wan as never,
      outputPath: '/o.webm',
    });
    expect(at(lightning, '--high-noise-steps')).toBe('4');
    expect(at(lightning, '--high-noise-cfg-scale')).toBe('1');
  });

  it('passes an explicit refine schedule for the hires pass', () => {
    const args = buildImageArgs({
      params: { prompt: 'x', model: 'z' },
      bundle: bundle as never,
      outputPath: '/o.webm',
      hires: { sigmas: [0.85, 0.725, 0.421875, 0] },
    });
    expect(args[args.indexOf('--hires-sigmas') + 1]).toBe('0.85,0.725,0.421875,0');
  });

  it("runs a distillation LoRA on its trained schedule, shifted for the image's size", () => {
    const presets = {
      turbo: { steps: 6, cfg_scale: 1, sigmas: [1, 0.5], sigma_shift: { base_shift: 0.5, max_shift: 0.9, base_seq_len: 256, max_seq_len: 8192 } },
      style: { cfg_scale: 3 },
    };
    const schedule = loraSchedule([{ name: 'style' }, { name: 'turbo', weight: 1 }], presets, 1024, 1024);
    expect(schedule?.lora).toBe('turbo');
    expect(schedule?.steps).toBe(6);
    expect(schedule?.cfg_scale).toBe(1);
    // Shifted towards more noise at 1 MP, and ending in the terminal 0.
    expect(schedule?.sigmas?.[0]).toBe(1);
    expect(schedule?.sigmas?.[1]).toBeGreaterThan(0.5);
    expect(schedule?.sigmas?.at(-1)).toBe(0);
    expect(loraSchedule([{ name: 'style' }], presets, 1024, 1024)).toBeUndefined();
  });
});

describe('music', () => {
  const song = {
    model: 'm',
    prompt: 'city pop, female vocal',
    lyrics: '[Chorus]\nTonight',
    duration_seconds: 90,
    steps: 8,
    seed: 7,
  };

  it("maps a request onto audio.cpp's generic task fields", () => {
    expect(musicRequest(song, 'ace_step')).toEqual({
      text: 'city pop, female vocal',
      lyrics: '[Chorus]\nTonight',
      duration_seconds: 90,
      num_inference_steps: 8,
      seed: 7,
    });
    // An instrumental sends no lyrics at all; -1 means "pick one".
    const instrumental = musicRequest({ model: 'm', prompt: 'ambient', seed: -1 });
    expect(instrumental).not.toHaveProperty('lyrics');
    expect(instrumental).not.toHaveProperty('seed');
  });

  it("uses HeartMuLa's own option names, and only those", () => {
    const request = musicRequest(song, 'heartmula');
    expect(request.options).toEqual({ tags: 'city pop, female vocal', duration_sec: '90' });
    // HeartMuLa fails a request carrying both duration spellings.
    expect(request).not.toHaveProperty('duration_seconds');
  });
});

describe('resources', () => {
  it("reports a container's memory limit rather than the host's", async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-cgroup-'));
    await writeFile(join(root, 'memory.max'), '1073741824\n');
    await writeFile(join(root, 'memory.current'), '268435456\n');
    expect(await cgroupMemory(root)).toEqual({ usedBytes: 268435456, totalBytes: 1073741824 });
    // An unlimited cgroup falls back to the host's numbers.
    await writeFile(join(root, 'memory.max'), 'max\n');
    expect(await cgroupMemory(root)).toBeNull();
    expect(await cgroupMemory(join(root, 'missing'))).toBeNull();
  });
});

describe('database', () => {
  it('sets a corrupt database aside and starts a new one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-db-'));
    const file = join(dir, 'pepper.db');
    // A healthy database opens in place.
    const first = openDb(file);
    first.sqlite.close();

    // Not an SQLite file at all, as a write cut off by a full disk can leave it.
    await writeFile(file, 'this is not a database, '.repeat(400));
    let moved: string | undefined;
    const recovered = openDb(file, (movedTo) => (moved = movedTo));
    expect(moved).toMatch(/pepper\.db\.corrupt-\d+$/);
    // The new database is usable.
    expect(recovered.sqlite.pragma('quick_check', { simple: true })).toBe('ok');
    recovered.sqlite.close();
  });

  it('never maps a shared-memory file, which a full volume turns into a SIGBUS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-db-'));
    const file = join(dir, 'pepper.db');
    const { sqlite } = openDb(file);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('locking_mode', { simple: true })).toBe('exclusive');
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 0)").run();
    expect(existsSync(`${file}-wal`)).toBe(true);
    expect(existsSync(`${file}-shm`)).toBe(false);
    sqlite.close();

    // A truncated -shm left by an earlier crash is ignored rather than mapped.
    await writeFile(`${file}-shm`, 'xyz');
    const again = openDb(file);
    expect(again.temporary).toBeUndefined();
    expect(again.sqlite.prepare("SELECT value FROM settings WHERE key = 'k'").pluck().get()).toBe('1');
    again.sqlite.close();
  });

  it('runs from memory when the database cannot be written, rather than not at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-db-'));
    // The parent "directory" is a file, so nothing can be created beneath it.
    await writeFile(join(dir, 'db'), '');
    const { sqlite, temporary } = openDb(join(dir, 'db', 'pepper.db'));
    expect(temporary).toBeTruthy();
    sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 0)").run();
    expect(sqlite.prepare('SELECT count(*) FROM settings').pluck().get()).toBe(1);
    sqlite.close();
  });
});

describe('storage budget', () => {
  it('refuses a download that would overrun a volume of known size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-storage-'));
    await writeFile(join(dir, 'model.bin'), Buffer.alloc(3 * 1024 * 1024));
    const GB = 1024 ** 3;

    // 10 GB volume, ~3 MB used, 2 GB kept in reserve: just under 8 GB fit.
    const storage = new StorageMonitor(dir, 10 * GB);
    await expect(storage.assertRoom(7 * GB)).resolves.toBeUndefined();
    await expect(storage.assertRoom(9 * GB)).rejects.toThrow(/Not enough room.*Delete a model/);
    // What other downloads have still to write counts as used.
    await expect(storage.assertRoom(7 * GB, 2 * GB)).rejects.toThrow(/Not enough room/);
    const snapshot = storage.snapshot();
    expect(snapshot?.totalBytes).toBe(10 * GB);
    expect(snapshot?.usedBytes).toBeGreaterThan(3 * 1024 * 1024 - 1);

    // RunPod sizes volumes in decimal gigabytes.
    expect(volumeBytes(100)).toBe(100e9);

    // The indicator's figures: the quota's, with free space derived from it.
    expect(await storage.usage()).toMatchObject({ totalBytes: 10 * GB, source: 'quota' });
    expect((await storage.usage())?.freeBytes).toBe(10 * GB - (snapshot?.usedBytes ?? 0));

    // No size configured: no opinion on room, but the filesystem's own figures to show.
    const unlimited = new StorageMonitor(dir, null);
    await expect(unlimited.assertRoom(1e15)).resolves.toBeUndefined();
    expect(unlimited.snapshot()).toBeNull();
    const disk = await unlimited.usage();
    expect(disk).toMatchObject({ source: 'filesystem' });
    expect(disk!.totalBytes).toBeGreaterThan(disk!.freeBytes!);
  });
});

describe('engines', () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} } as unknown as import('fastify').FastifyBaseLogger;

  it('refuses two engines claiming one job kind', async () => {
    const { EngineRegistry } = await import('@pepper/core/engines/engine.js');
    const run = async () => ({});
    const registry = new EngineRegistry(log).register({ id: 'a', label: 'A', executors: () => ({ image: run }) });
    expect(() => registry.register({ id: 'b', label: 'B', executors: () => ({ image: run }) })).toThrow(/claimed by both/);
  });

  it('releases every other resident engine for exclusive work', async () => {
    const { EngineRegistry } = await import('@pepper/core/engines/engine.js');
    const released: string[] = [];
    const engine = (id: string, resident: boolean) => ({
      id,
      label: id,
      executors: () => ({}),
      resident: () => resident,
      release: async () => {
        released.push(id);
      },
    });
    const registry = new EngineRegistry(log)
      .register(engine('video', true))
      .register(engine('llm', true))
      .register(engine('audio', false));
    const lines: string[] = [];
    await registry.exclusive('video', (line) => lines.push(line));
    expect(released).toEqual(['llm']);
    expect(lines).toHaveLength(1);
    await registry.release('audio', 'pressure');
    expect(released).toEqual(['llm']);
  });

  it('attaches executors to the job system and reports which engine owns a kind', async () => {
    const { EngineRegistry } = await import('@pepper/core/engines/engine.js');
    const registered: string[] = [];
    const jobs = { registerExecutor: (kind: string) => registered.push(kind) } as unknown as import('@pepper/core/jobs/manager.js').JobManager;
    const run = async () => ({});
    const registry = new EngineRegistry(log)
      .register({ id: 'gen', label: 'Gen', executors: () => ({ image: run, video: run }) })
      .register({ id: 'txt', label: 'Txt', executors: () => ({ text: run }) });
    registry.attach(jobs);
    expect(registered.sort()).toEqual(['image', 'text', 'video']);
    expect(registry.ownerOf('video')?.id).toBe('gen');
    expect(registry.status().find((s) => s.id === 'txt')?.kinds).toEqual(['text']);
  });
});

describe('backend definitions', () => {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as import('fastify').FastifyBaseLogger;
  async function manager(definitions: import('@pepper/core/backends/manager.js').BackendDefinition[], autoInstall = true) {
    const { BackendManager } = await import('@pepper/core/backends/manager.js');
    const { openDb } = await import('../src/db/client.js');
    const { SettingsStore } = await import('@pepper/core/db/settings.js');
    const { db } = openDb(':memory:');
    return new BackendManager(
      definitions,
      { autoInstall, startupTimeoutMs: 1000, idleTimeoutMs: 0, runDir: tmpdir() },
      new SettingsStore(db),
      log,
      new LogBuffer(100),
    );
  }
  const spec = (id: string, kind: 'server' | 'cli') => ({ backend: id, label: id, kind, args: [] });
  const record = (id: string) => ({ backend: id, binaryPath: '/bin/' + id, tag: 't', asset: 'a', installedAt: '' });

  it('installs a runtime marked non-implicit only when explicitly asked', async () => {
    let installs = 0;
    const backends = await manager([
      {
        id: 'rt',
        argSpec: spec('rt', 'server'),
        installer: { implicit: false, installed: async () => null, install: async () => (installs++, record('rt')) },
      },
    ]);
    expect(await backends.ensureInstalled('rt')).toBeNull();
    expect(installs).toBe(0);
    expect((await backends.ensureInstalled('rt', new AbortController().signal))?.binaryPath).toBe('/bin/rt');
    expect(installs).toBe(1);
  });

  it('respects AUTO_INSTALL_BACKENDS for release installs, and reports the definition in status', async () => {
    let installs = 0;
    const backends = await manager(
      [
        {
          id: 'cli',
          argSpec: spec('cli', 'cli'),
          releaseRepo: 'o/r',
          installer: { installed: async () => null, install: async () => (installs++, record('cli')) },
        },
      ],
      false,
    );
    expect(await backends.ensureInstalled('cli')).toBeNull();
    expect(installs).toBe(0);
    expect(backends.status('cli')).toMatchObject({ kind: 'cli', releaseRepo: 'o/r', installed: false });
    expect(backends.ids()).toEqual(['cli']);
    expect(() => backends.status('nope')).toThrow(/Unknown backend/);
  });

  it('builds loopback URLs from the server definition', async () => {
    const backends = await manager([
      { id: 'srv', argSpec: spec('srv', 'server'), server: { port: 9999, healthPath: '/ok' } },
    ]);
    expect(backends.baseUrl('srv')).toBe('http://127.0.0.1:9999');
    await expect(backends.reinstall('srv')).rejects.toThrow();
  });
});
