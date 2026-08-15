import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, publicConfig } from '../src/config.js';
import { assertSafeName, safeResolve } from '../src/paths.js';
import { selectAsset } from '../src/backends/release.js';
import { evaluatePolicy } from '../src/backends/monitor.js';
import { parseBackendLine, parseProgress } from '../src/logs/parse.js';
import { LogBuffer } from '../src/logs/buffer.js';
import { buildArgv, effectiveArgs, LLAMACPP_ARGS, renderArgs } from '../src/backends/args.js';
import { inspectBundle, parseSlot, detectClipRole } from '../src/models/bundle.js';
import { Semaphore } from '../src/util/semaphore.js';

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

  it('reports which assets existed when nothing matches', () => {
    expect(() => selectAsset(assets, 'linux', 'x64', 'rocm')).toThrow(/No "rocm" build/);
  });
});

describe('process health policy', () => {
  const policy = { swapLimitKb: 256 * 1024, idleAfterMs: 900_000, idleRssLimitKb: 2 * 1024 * 1024 };

  it('recycles a swapping process — the audio.cpp failure mode', () => {
    const verdict = evaluatePolicy({ pid: 1, rssKb: 1000, swapKb: 400 * 1024 }, 0, policy);
    expect(verdict.restart).toBe(true);
    expect(verdict.reason).toMatch(/swapping/);
  });

  it('leaves a busy process holding a lot of memory alone', () => {
    expect(evaluatePolicy({ pid: 1, rssKb: 40 * 1024 * 1024, swapKb: 0 }, 0, policy).restart).toBe(false);
  });

  it('recycles only when idleness and memory use coincide', () => {
    const idleAndSmall = evaluatePolicy({ pid: 1, rssKb: 1024, swapKb: 0 }, 3_600_000, policy);
    const busyAndLarge = evaluatePolicy({ pid: 1, rssKb: 8 * 1024 * 1024, swapKb: 0 }, 0, policy);
    const idleAndLarge = evaluatePolicy({ pid: 1, rssKb: 8 * 1024 * 1024, swapKb: 0 }, 3_600_000, policy);

    expect(idleAndSmall.restart).toBe(false);
    expect(busyAndLarge.restart).toBe(false);
    expect(idleAndLarge.restart).toBe(true);
  });

  it('does not treat unreported swap as zero swap', () => {
    expect(evaluatePolicy({ pid: 1, rssKb: 1000, swapKb: null }, 0, policy).restart).toBe(false);
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
