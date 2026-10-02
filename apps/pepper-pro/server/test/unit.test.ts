import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ObjectInfo, Prompt } from '../src/comfy/client.js';
import { prune, validatePrompt } from '../src/comfy/graph.js';
import { loadConfig } from '../src/config.js';
import { buildPrompt } from '../src/engines/build.js';
import { AnalyzeEngine } from '../src/engines/analyze.js';
import { ProgressTracker, outputFiles } from '../src/engines/comfy.js';
import { resolveParams } from '../src/engines/params.js';
import { buildCutArgs, buildSrt, frameFor, isSilent, parseLoudness, snapToBeats, type Segment } from '../src/engines/render.js';
import { describeModel, mapRequest, pickModel, type ModelDescription } from '../src/generate.js';
import { joinArgs, planSegments } from '../src/projects/chain.js';
import { composePrompt, deriveParams, sizeFor } from '../src/projects/derive.js';
import type { AssetRow, ProjectRow, ShotRow } from '../src/projects/schema.js';
import { checkRecipe } from '../src/recipes/check.js';
import { goldenFileSchema, goldenParams } from '../src/golden/service.js';
import { recipeSchema, type Recipe } from '../src/recipes/schema.js';
import { RecipeStore, licenceBlock, variantFor, variantName, variantUrl } from '../src/recipes/store.js';
import { comfyLayout } from '../src/recipes/layout.js';
import { buildPaths } from '../src/paths.js';
import { modelPathsYaml } from '../src/backends.js';
import { buildServer, type ProServer } from '../src/server.js';
import { probeMedia } from '@pepper/core/util/ffmpeg.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/recipes', import.meta.url));
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log } as unknown as FastifyBaseLogger;

async function tempConfig(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pepper-pro-'));
  return loadConfig({
    DATA_DIR: root,
    OUTPUT_DIR: join(root, 'out'),
    RECIPES_DIR: FIXTURES,
    AUTO_INSTALL_BACKENDS: 'false',
    LOG_LEVEL: 'error',
    COMFY_DIR: join(root, 'no-comfy'),
    ...env,
  });
}

async function loadStore(): Promise<RecipeStore> {
  const config = await tempConfig();
  const store = new RecipeStore(FIXTURES, buildPaths(config), log);
  await store.load();
  return store;
}

/** Just enough of /object_info for the fixture workflows. */
const OBJECT_INFO: ObjectInfo = {
  EmptyImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'], color: ['INT'] } }, output: ['IMAGE'] },
  ImageInvert: { input: { required: { image: ['IMAGE'] } }, output: ['IMAGE'] },
  LoadImage: { input: { required: { image: [['a.png', 'b.png']] } }, output: ['IMAGE', 'MASK'] },
  ImageStitch: {
    input: {
      required: { image1: ['IMAGE'], direction: ['COMBO', { options: ['right', 'down'] }], match_image_size: ['BOOLEAN'], spacing_width: ['INT'], spacing_color: ['COMBO', { options: ['white'] }] },
      optional: { image2: ['IMAGE'] },
    },
    output: ['IMAGE'],
  },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [] },
};

describe('recipes', () => {
  it('loads the fixture recipes and their workflows', async () => {
    const store = await loadStore();
    expect(store.list().map((r) => r.id).sort()).toEqual(['test-audio', 'test-continue', 'test-image', 'test-video']);
    expect(store.broken).toEqual([]);
    expect(Object.keys(store.workflow(store.require('test-image'), 'main'))).toContain('4');
  });

  it('rejects a recipe whose bindings name unknown params or files', () => {
    const bad = {
      schema: 1,
      id: 'bad',
      version: 1,
      kind: 'image',
      name: 'Bad',
      description: '',
      family: 'x',
      licence: { id: 'x', name: 'X', commercial: 'yes' },
      files: [],
      params: [],
      workflows: { main: { file: 'w.json', bindings: [{ param: 'nope', node: '1', input: 'x' }, { file: 'ghost', node: '1', input: 'y' }], outputs: [{ node: '1', kind: 'image' }] } },
      modes: { a: { label: 'A', workflow: 'missing' } },
      default_mode: 'b',
      tiers: ['32gb'],
    };
    const result = recipeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((i) => i.message).join(' | ');
    expect(messages).toMatch(/unknown param "nope"/);
    expect(messages).toMatch(/unknown file "ghost"/);
    expect(messages).toMatch(/unknown workflow "missing"/);
    expect(messages).toMatch(/default_mode "b"/);
  });

  it('picks the file variant for a tier and builds its URL', () => {
    const file = {
      id: 'dit',
      folder: 'diffusion_models' as const,
      label: 'DiT',
      optional: false,
      variants: [
        { tiers: ['96gb' as const], repo: 'Org/Model', path: 'dm/model_bf16.safetensors', revision: 'main' },
        { repo: 'Org/Model', path: 'dm/model int8.safetensors', revision: 'main' },
      ],
    };
    expect(variantName(variantFor(file, '96gb'))).toBe('model_bf16.safetensors');
    expect(variantName(variantFor(file, '32gb'))).toBe('model int8.safetensors');
    expect(variantUrl(variantFor(file, '32gb'))).toBe('https://huggingface.co/Org/Model/resolve/main/dm/model%20int8.safetensors');
  });

  it('blocks non-commercial recipes in commercial mode only', () => {
    const licence = { id: 'x', name: 'Research licence', commercial: 'no' as const, excluded_territories: [], obligations: [] };
    expect(licenceBlock(licence, 'personal')).toBeUndefined();
    expect(licenceBlock(licence, 'commercial')).toMatch(/does not allow commercial use/);
  });

  it('reports install state from disk, counting only required files', async () => {
    const config = await tempConfig();
    const paths = buildPaths(config);
    const store = new RecipeStore(FIXTURES, paths, log);
    await store.load();
    // test-audio has only an optional file, so it is usable with nothing downloaded.
    expect((await store.status(store.require('test-audio'), '32gb', 'personal')).state).toBe('installed');
  });

  it('files downloads into ComfyUI folders and refuses others', async () => {
    const config = await tempConfig();
    const layout = comfyLayout(buildPaths(config));
    const paths = await layout.componentPaths('comfy', 'loras', 'file', 'turbo.safetensors');
    expect(paths.finalPath).toBe(join(config.dataDir, 'models', 'loras', 'turbo.safetensors'));
    await expect(layout.componentPaths('comfy', 'etc', 'file', 'x')).rejects.toThrow(/not a ComfyUI model folder/);
    expect(() => layout.fileNameFor('https://x/y/../a.bin', '../a.bin')).toThrow();
    expect(modelPathsYaml('/data/models')).toMatch(/base_path: "\/data\/models"\n  is_default: true\n  checkpoints: checkpoints/);
    // A checkpoint a node pack loads as a directory lands in its sub-directory.
    const nested = await layout.componentPaths('comfy', 'qwen-tts/Qwen3-TTS-12Hz-1.7B-Base/speech_tokenizer', 'file', 'model.safetensors');
    expect(nested.finalPath).toBe(join(config.dataDir, 'models', 'qwen-tts', 'Qwen3-TTS-12Hz-1.7B-Base', 'speech_tokenizer', 'model.safetensors'));
    await expect(layout.componentPaths('comfy', 'qwen-tts/../../etc', 'file', 'x')).rejects.toThrow();
  });

  it('checks the files a workflow requires and places sub-directory variants', async () => {
    const recipe = {
      schema: 1,
      id: 'dirs',
      version: 1,
      kind: 'audio',
      name: 'Dirs',
      description: '',
      family: 'x',
      licence: { id: 'x', name: 'X', commercial: 'yes' },
      files: [{ id: 'cfg', folder: 'qwen-tts', label: 'Config', variants: [{ repo: 'Org/M', path: 'config.json', dir: 'M/sub', bytes: 1 }] }],
      params: [{ name: 'style', type: 'enum', label: 'Style', options: ['A', 'B'] }],
      workflows: {
        main: {
          file: 'w.json',
          bindings: [{ param: 'style', node: '1', input: 'index', map: { A: 0, B: 1 } }],
          requires_files: ['cfg', 'ghost'],
          outputs: [{ node: '1', kind: 'audio' }],
        },
      },
      modes: { final: { label: 'F', workflow: 'main' } },
      default_mode: 'final',
      tiers: ['32gb'],
    };
    const bad = recipeSchema.safeParse(recipe);
    expect(bad.success ? '' : bad.error.issues.map((i) => i.message).join()).toMatch(/requires unknown file "ghost"/);
    recipe.workflows.main.requires_files = ['cfg'];
    const parsed = recipeSchema.parse(recipe);
    expect(recipeSchema.safeParse({ ...recipe, files: [{ ...recipe.files[0], variants: [{ ...recipe.files[0].variants[0], dir: '../up' }] }] }).success).toBe(false);
    const store = new RecipeStore(FIXTURES, buildPaths(await tempConfig()), log);
    const [resolved] = await store.resolveFiles(parsed, '32gb');
    expect(resolved.relPath).toBe('qwen-tts/M/sub/config.json');
    expect(resolved.path.endsWith(join('models', 'qwen-tts', 'M', 'sub', 'config.json'))).toBe(true);
    // An enum reaches the graph through its map.
    const prompt = buildPrompt({
      recipe: parsed,
      mode: parsed.modes.final,
      workflow: parsed.workflows.main,
      template: { 1: { class_type: 'X', inputs: { index: 9 } } },
      values: { style: 'B' },
      files: [],
    });
    expect(prompt[1].inputs.index).toBe(1);
  });
});

describe('recipe parameters', () => {
  it('fills defaults per mode, draws a seed, and rejects unknown names', async () => {
    const recipe = (await loadStore()).require('test-image');
    const draft = resolveParams(recipe, recipe.modes.draft, {});
    expect(draft).toMatchObject({ width: 32, height: 32, color: 0 });
    expect(typeof draft.seed).toBe('number');
    expect(resolveParams(recipe, recipe.modes.final, { seed: 7 }).width).toBe(64);
    expect(() => resolveParams(recipe, recipe.modes.draft, { witdh: 1 })).toThrow(/no parameter "witdh"/);
    expect(() => resolveParams(recipe, recipe.modes.draft, { width: 4 })).toThrow(/at least 16/);
    expect(() => resolveParams(recipe, recipe.modes.draft, { refs: ['a.png', 'b.png'] })).toThrow(/at most 1/);
  });
});

describe('graph building', () => {
  async function build(values: Record<string, unknown>) {
    const store = await loadStore();
    const recipe = store.require('test-image');
    return buildPrompt({
      recipe,
      mode: recipe.modes.draft,
      workflow: recipe.workflows.main,
      template: store.workflow(recipe, 'main'),
      values,
      files: [],
      objectInfo: OBJECT_INFO,
      validate: { ignoreFileChoices: true },
    });
  }

  it('binds parameters without touching the stored template', async () => {
    const prompt = await build({ width: 100, height: 50, color: 5, refs: ['a.png'] });
    expect(prompt['1'].inputs).toMatchObject({ width: 100, height: 50, color: 5 });
    expect(prompt['3'].inputs.image).toBe('a.png');
    expect(prompt['4'].inputs.image2).toEqual(['3', 0]);
    const store = await loadStore();
    expect(store.workflow(store.require('test-image'), 'main')['1'].inputs.width).toBe(64);
  });

  it('prunes an empty list slot and drops the optional input that fed on it', async () => {
    const prompt = await build({ width: 32, height: 32 });
    expect(prompt['3']).toBeUndefined();
    expect(prompt['4'].inputs.image2).toBeUndefined();
    expect(prompt['5']).toBeDefined();
  });

  it('cascades through required inputs', () => {
    const prompt: Prompt = {
      a: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      b: { class_type: 'ImageInvert', inputs: { image: ['a', 0] } },
      c: { class_type: 'SaveImage', inputs: { images: ['b', 0], filename_prefix: 'x' } },
      d: { class_type: 'EmptyImage', inputs: { width: 1, height: 1, batch_size: 1, color: 0 } },
    };
    prune(prompt, ['a'], OBJECT_INFO);
    expect(Object.keys(prompt)).toEqual(['d']);
  });

  it('reports unknown nodes, missing inputs, dangling links and bad choices', () => {
    const issues = validatePrompt(
      {
        1: { class_type: 'Nope', inputs: {} },
        2: { class_type: 'ImageInvert', inputs: {} },
        3: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'x' } },
        4: { class_type: 'ImageStitch', inputs: { image1: ['2', 3], direction: 'sideways', match_image_size: true, spacing_width: 0, spacing_color: 'white' } },
        5: { class_type: 'LoadImage', inputs: { image: 'missing.png' } },
      },
      OBJECT_INFO,
    ).map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unknown node type Nope/),
        expect.stringMatching(/missing required input "image"/),
        expect.stringMatching(/links to missing node 9/),
        expect.stringMatching(/links to output 3 of ImageInvert/),
        expect.stringMatching(/direction is "sideways"/),
        expect.stringMatching(/image is "missing.png"/),
      ]),
    );
    const lenient = validatePrompt({ 5: { class_type: 'LoadImage', inputs: { image: 'missing.png' } } }, OBJECT_INFO, { ignoreFileChoices: true });
    expect(lenient).toEqual([]);
  });
  it('checks numbers against their bounds, and draws seeds within a seed parameter\'s max', () => {
    const info: ObjectInfo = { Sampler: { input: { required: { seed: ['INT', { min: 0, max: 2147483647 }] } }, output: [] } };
    expect(validatePrompt({ 1: { class_type: 'Sampler', inputs: { seed: 2 ** 40 } } }, info).map((i) => i.message)).toEqual([
      'Sampler.seed is 1099511627776, above its maximum 2147483647',
    ]);
    const recipe = { id: 'r', params: [{ name: 'seed', type: 'seed', label: 'Seed', required: false, max: 1000 }] } as unknown as Recipe;
    for (let i = 0; i < 50; i++) expect(resolveParams(recipe, { label: '', workflow: 'm', set: [], defaults: {} }, {}).seed).toBeLessThanOrEqual(1000);
  });

  it('checks link types and treats growable group members as optional', () => {
    const info: ObjectInfo = {
      ...OBJECT_INFO,
      Encode: {
        input: {
          required: {
            images: ['COMFY_AUTOGROW_V3', { template: { input: { required: { image: ['IMAGE'] } } } }],
            values: ['COMFY_AUTOGROW_V3', { template: { input: { required: { value: ['FLOAT,INT'] } } } }],
          },
        },
        output: ['CONDITIONING'],
      },
    };
    const prompt: Prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
      3: { class_type: 'Encode', inputs: { 'images.image_1': ['1', 0], 'images.image_2': ['2', 0], 'values.a': ['1', 1] } },
    };
    expect(validatePrompt(prompt, info).map((i) => i.message)).toEqual([
      'input "values.a" takes FLOAT,INT but is linked to MASK from LoadImage',
    ]);
    // Leaving one slot of a required group empty drops the slot, not the node.
    prune(prompt, ['2'], info);
    expect(prompt[3].inputs).not.toHaveProperty('images.image_2');
    expect(prompt[3]).toBeDefined();
  });
});

describe('shipped recipes', () => {
  // The node types the shipped recipes use, as the pinned ComfyUI reports
  // them; refreshed by `npm run validate-recipes -- --write-fixture …`.
  const RECIPES = fileURLToPath(new URL('../recipes', import.meta.url));

  it('build and validate in every mode, with and without their optional inputs', async () => {
    const info = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/object_info.json', import.meta.url)), 'utf8')) as ObjectInfo;
    const store = new RecipeStore(RECIPES, buildPaths(await tempConfig()), log);
    await store.load();
    expect(store.broken).toEqual([]);
    expect(store.list().length).toBeGreaterThanOrEqual(12);
    for (const tier of ['24gb-64ram', '96gb'] as const) {
      for (const recipe of store.list()) {
        const failures = checkRecipe(recipe, (name) => store.workflow(recipe, name), { tier, objectInfo: info }).filter((c) => c.issues.length > 0);
        expect(failures).toEqual([]);
      }
    }
  });

  it('pin every file to a size, and every licence that limits use says how', async () => {
    const store = new RecipeStore(RECIPES, buildPaths(await tempConfig()), log);
    await store.load();
    for (const recipe of store.list()) {
      for (const file of recipe.files) for (const variant of file.variants) expect(variant.bytes, `${recipe.id}/${file.id}`).toBeGreaterThan(0);
      if (recipe.licence.commercial !== 'yes') expect(recipe.licence.url, recipe.id).toBeTruthy();
      if (recipe.licence.excluded_territories.length > 0) expect(recipe.licence.ui_notice, recipe.id).toBeTruthy();
      expect(Object.keys(recipe.modes).length, recipe.id).toBeGreaterThan(0);
      // Shots draft then finish, so every recipe a shot can render with has both.
      if (recipe.kind === 'video' && recipe.params.some((p) => p.name === 'prompt')) expect(Object.keys(recipe.modes), recipe.id).toEqual(expect.arrayContaining(['draft', 'final']));
    }
  });
});

describe('golden shots', () => {
  const RECIPES = fileURLToPath(new URL('../recipes', import.meta.url));

  it('cover the four targets, and every shot fits a shipped recipe', async () => {
    const file = goldenFileSchema.parse(JSON.parse(await readFile(fileURLToPath(new URL('../golden/shots.json', import.meta.url)), 'utf8')));
    expect(new Set(file.shots.map((s) => s.target))).toEqual(new Set(['short drama', 'talking', 'product', 'fashion', 'music']));
    expect(new Set(file.shots.map((s) => s.id)).size).toBe(file.shots.length);
    const store = new RecipeStore(RECIPES, buildPaths(await tempConfig()), log);
    await store.load();
    for (const shot of file.shots) {
      const fits = store.list().filter((r) => r.kind === shot.kind && shot.capabilities.some((c) => r.capabilities.includes(c)));
      expect(fits.length, shot.id).toBeGreaterThan(0);
    }
    // Every generated input has a shipped recipe that can make it.
    for (const [name, input] of Object.entries(file.inputs)) {
      if (!input.generate) continue;
      expect(store.list().some((r) => r.kind === input.kind && r.capabilities.includes(input.generate!.capability)), name).toBe(true);
    }
  });

  it('map a shot onto each recipe by parameter name, or say why not', async () => {
    const file = goldenFileSchema.parse(JSON.parse(await readFile(fileURLToPath(new URL('../golden/shots.json', import.meta.url)), 'utf8')));
    const store = new RecipeStore(RECIPES, buildPaths(await tempConfig()), log);
    await store.load();
    const shot = (id: string) => file.shots.find((s) => s.id === id)!;
    const uploads = { mei: 'g-mei.png', jun: 'g-jun.png', host: 'g-host.png', voice: 'g-voice.wav', model: 'g-model.png', jacket: 'g-jacket.png' };
    expect(goldenParams(store.require('h3-reference'), shot('drama-dialogue'), uploads)).toEqual({
      params: expect.objectContaining({ refs: ['g-mei.png', 'g-jun.png'], seed: 2001 }),
    });
    expect(goldenParams(store.require('infinitetalk'), shot('talk-selfie'), uploads)).toEqual({
      params: expect.objectContaining({ image: 'g-host.png', audio: 'g-voice.wav' }),
    });
    expect(goldenParams(store.require('h3-video'), shot('drama-closeup'), uploads)).toEqual({
      params: expect.objectContaining({ first_frame: 'g-mei.png' }),
    });
    expect(goldenParams(store.require('flux2-klein-edit'), shot('edit-tryon'), uploads)).toEqual({
      params: expect.objectContaining({ image: 'g-model.png', reference: 'g-jacket.png' }),
    });
    expect(goldenParams(store.require('ltx23-audio-to-video'), shot('drama-action'), uploads)).toEqual({
      skip: expect.stringMatching(/image, audio/),
    });
  });
});

describe('engine helpers', () => {
  it('weights progress across a two-stage render', () => {
    const tracker = new ProgressTracker({ draft: 1, refine: 3 });
    expect(tracker.update('draft', 5, 10).progress).toBeCloseTo(0.125);
    expect(tracker.update('refine', 0, 4).progress).toBeCloseTo(0.25);
    expect(tracker.update('refine', 2, 4).progress).toBeCloseTo(0.625);
    const plain = new ProgressTracker();
    expect(plain.update('x', 3, 4)).toEqual({ step: 3, total: 4, progress: 0.75 });
  });

  it('finds output files under any key a node uses', () => {
    expect(
      outputFiles({ images: [{ filename: 'a.png', subfolder: '', type: 'output' }], animated: [true], audio: [{ filename: 'b.flac', subfolder: 'audio', type: 'output' }] }).map((f) => f.filename),
    ).toEqual(['a.png', 'b.flac']);
  });
});

describe('shots to recipe parameters', () => {
  const project = { id: 'p', name: 'P', description: '', aspect: '9:16', fps: 24, style: 'Warm film look.', lut: null, licenceMode: 'personal', script: '', createdAt: 0, updatedAt: 0 } as ProjectRow;
  const asset = (id: string, name: string, extra: Partial<AssetRow> = {}): AssetRow => ({
    id,
    projectId: 'p',
    kind: 'character',
    name,
    description: `${name} description`,
    images: [`${id}.png`],
    voice: { upload: `${id}.wav` },
    audio: null,
    meta: {},
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });
  const shot = (extra: Partial<ShotRow> = {}): ShotRow => ({
    id: 's',
    projectId: 'p',
    sceneId: 'c',
    position: 0,
    kind: 'dialogue',
    durationS: 6,
    framing: 'Medium two-shot',
    camera: 'slow push-in',
    prompt: 'They argue in the rain.',
    dialogue: [{ asset_id: 'a1', line: 'You lied to me' }, { asset_id: 'a2', line: 'I had to.' }],
    sound: 'rain on the umbrella',
    assetIds: ['a1', 'a2'],
    keyframes: {},
    audioAssetId: null,
    recipeId: null,
    params: {},
    chosenTakeId: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  });
  const recipe = (params: Recipe['params'], capabilities: string[] = []) => ({ params, capabilities }) as unknown as Recipe;

  it('writes H3-style subject tags and quoted dialogue for subject-tag recipes', () => {
    const text = composePrompt({ project, shot: shot(), assets: [asset('a1', 'Mei'), asset('a2', 'Jun')], recipe: recipe([], ['subject-tags']) });
    expect(text).toContain('Warm film look.');
    expect(text).toContain('<Subject 1> is Mei (<Picture 1>): Mei description');
    expect(text).toContain('<Subject 2> is Jun (<Picture 2>)');
    expect(text).toContain('Medium two-shot, slow push-in. They argue in the rain.');
    expect(text).toContain('<Subject 1> says exactly this: "You lied to me."');
    expect(text).toContain('Sound: rain on the umbrella');
    const plain = composePrompt({ project, shot: shot(), assets: [asset('a1', 'Mei'), asset('a2', 'Jun')], recipe: recipe([]) });
    expect(plain).toContain('Mei says exactly this');
    expect(plain).not.toContain('<Subject');
  });

  it('derives only the parameters a recipe declares, and lets the shot override', () => {
    const params = deriveParams({
      project,
      shot: shot({ keyframes: { first: 'k1.png' }, params: { seed: 5 } }),
      assets: [asset('a1', 'Mei'), asset('a2', 'Jun')],
      recipe: recipe([
        { name: 'prompt', type: 'text', label: '', required: false },
        { name: 'refs', type: 'images', label: '', required: false, max_items: 1 },
        { name: 'first_frame', type: 'image', label: '', required: false },
        { name: 'voice_refs', type: 'audios', label: '', required: false },
        { name: 'duration', type: 'int', label: '', required: false, min: 4, max: 15 },
        { name: 'width', type: 'int', label: '', required: false, default: 1344 },
        { name: 'height', type: 'int', label: '', required: false, default: 768 },
        { name: 'seed', type: 'seed', label: '', required: false },
      ]),
    });
    expect(params).toMatchObject({ refs: ['a1.png'], first_frame: 'k1.png', voice_refs: ['a1.wav', 'a2.wav'], duration: 6, seed: 5 });
    expect(params.width).toBeLessThan(params.height as number);
    expect(sizeFor('9:16', 1344, 768)).toEqual({ width: 768, height: 1344 });
    const sized = recipe([
      { name: 'width', type: 'int', label: '', required: false, default: 1344 },
      { name: 'height', type: 'int', label: '', required: false, default: 768 },
    ]);
    sized.modes = { draft: { label: '', workflow: 'main', set: [], defaults: { width: 672, height: 384 } } };
    sized.default_mode = 'final';
    // A draft take is sized from the draft mode's pixel count, not the finish's.
    expect(deriveParams({ project, shot: shot(), assets: [], recipe: sized, mode: 'draft' })).toMatchObject({ width: 384, height: 672 });
    expect(sizeFor('1:1', 1024, 1024)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('long takes', () => {
  it('splits a long shot into segments that each repeat the overlap', () => {
    // 20 s of H3 (15 s max, 22 frames of overlap): 15 s, then 5 s more plus the repeat.
    const overlap = 22 / 24;
    const segments = planSegments(20, { max: 15, min: 1, overlap });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toBe(15);
    expect(segments[1]).toBeCloseTo(5 + overlap, 2);
    // Added footage (all of the first, the rest minus the repeat) is the shot's length.
    expect(segments[0] + segments[1] - overlap).toBeCloseTo(20, 1);
  });

  it('repeats the overlap from the first segment when continuing a retake', () => {
    expect(planSegments(3, { max: 15, overlap: 1, continuing: true })).toEqual([4]);
    // Too short a remainder is lengthened to the recipe's minimum; the join trims it back.
    expect(planSegments(0.2, { max: 1.5, min: 0.5, overlap: 0.25, continuing: true })).toEqual([0.5]);
  });

  it('refuses segments that cannot make progress, or too many of them', () => {
    expect(() => planSegments(10, { max: 1, overlap: 0.5 })).toThrow(/cannot continue/);
    expect(() => planSegments(600, { max: 15, overlap: 1 })).toThrow(/more than 12 segments/);
  });

  it('trims each continuation and cuts sound at the same seams', () => {
    const args = joinArgs(
      [{ path: '/a.mp4', end: 6 }, { path: '/b.mp4', start: 0.917 }],
      { audio: true, total: 10, fps: 24, output: '/out.mp4' },
    );
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]trim=end=6.000,');
    expect(graph).toContain('[1:v]trim=start=0.917,');
    expect(graph).toContain('[1:a]atrim=start=0.917,');
    expect(graph).toContain('concat=n=2:v=1:a=1[v][a]');
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '10.000']);
    const silent = joinArgs([{ path: '/a.mp4' }, { path: '/b.mp4', start: 1 }], { audio: false, total: 5, fps: 24, output: '/o.mp4' });
    expect(silent.join(' ')).not.toContain('[a');
  });
});

describe('cut rendering', () => {
  const segment = (duration: number, transition: 'cut' | 'fade', extra: Partial<Segment> = {}): Segment => ({
    path: `/t/${duration}.mp4`,
    info: { duration: 10, hasAudio: true, hasVideo: true, still: false },
    start: 0,
    duration,
    transition,
    lines: [],
    ...extra,
  });

  it('moves joins back onto the beat, never lengthening a take', () => {
    const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7];
    const snapped = snapToBeats([segment(2.3, 'cut'), segment(3, 'cut'), segment(4, 'cut')], beats);
    // 2.3 -> 2.0; the second starts at 2.0 and its natural join at 5.0 is on a beat.
    expect(snapped.map((s) => s.duration)).toEqual([2, 3, 4]);
    // With a crossfade into the next take the join is where the fade starts.
    const faded = snapToBeats([segment(2.8, 'cut'), segment(3, 'fade')], beats);
    // 2.8 s fading out from 2.3 s: the fade now starts on the 2.0 s beat.
    expect(faded[0].duration).toBeCloseTo(2.5, 5);
    // A take shorter than the minimum past its last beat is left alone.
    expect(snapToBeats([segment(1.2, 'cut'), segment(1, 'cut')], [0.5, 2])[0].duration).toBe(1.2);
  });

  it('joins with concat or xfade, mixes a ducked bed and normalises loudness', () => {
    const { args, duration } = buildCutArgs({
      segments: [segment(4, 'cut'), segment(3, 'fade'), segment(2, 'cut', { info: { duration: 0, hasAudio: false, hasVideo: true, still: true } })],
      ...frameFor('9:16'),
      fps: 24,
      music: { path: '/m.mp3', gainDb: -14, duck: true },
      lut: '/look.cube',
      output: '/out.mp4',
      loudness: { measured: { input_i: '-20.1', input_tp: '-3.0', input_lra: '4.0', input_thresh: '-30.5', target_offset: '0.2' } },
    });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(duration).toBeCloseTo(8.5);
    expect(graph).toContain('scale=1080:1920');
    expect(graph).toContain('xfade=transition=fade:duration=0.5:offset=3.500');
    expect(graph).toContain('concat=n=2:v=1:a=1');
    expect(graph).toContain('sidechaincompress');
    expect(graph).toContain("lut3d=file='/look.cube'");
    expect(graph).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-20.1');
    expect(graph).toContain('linear=true');
    expect(args).toContain('-loop');
    expect(args.slice(-1)[0]).toBe('/out.mp4');

    const measure = buildCutArgs({ segments: [segment(4, 'cut'), segment(3, 'fade')], ...frameFor('16:9'), fps: 24, output: '/o.mp4', loudness: { measure: true } });
    const audioOnly = measure.args[measure.args.indexOf('-filter_complex') + 1];
    expect(audioOnly).not.toContain('scale=');
    expect(audioOnly).toContain('print_format=json');
    expect(measure.args.slice(-2)).toEqual(['null', '-']);
  });

  it('reads loudnorm’s measurement and treats silence as silence', () => {
    const log = 'blah\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-23.40",\n\t"input_tp" : "-6.1",\n\t"input_lra" : "2.0",\n\t"input_thresh" : "-33.6",\n\t"target_offset" : "0.1"\n}\n';
    const measured = parseLoudness(log);
    expect(measured?.input_i).toBe('-23.40');
    expect(isSilent(measured)).toBe(false);
    expect(isSilent({ ...measured!, input_i: '-inf' })).toBe(true);
    expect(isSilent(null)).toBe(true);
  });

  it('spreads each segment’s lines across its time on screen', () => {
    const srt = buildSrt([segment(4, 'cut', { lines: ['One.', 'Two.'] }), segment(2, 'cut', { lines: ['Three.'] })]);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,950\nOne.');
    expect(srt).toContain('00:00:02,000 --> 00:00:03,950\nTwo.');
    expect(srt).toContain('00:00:04,000 --> 00:00:05,950\nThree.');
  });
});

describe('generic generation', () => {
  const RECIPES = fileURLToPath(new URL('../recipes', import.meta.url));
  let store: RecipeStore;
  let models: ModelDescription[];
  const installed = { state: 'installed' as const, files: [], missingBytes: 0, installBytes: 0, tierVerified: true };
  beforeAll(async () => {
    store = new RecipeStore(RECIPES, buildPaths(await tempConfig()), log);
    await store.load();
    models = store.list().map((r) => describeModel(r, installed));
  });
  const model = (id: string) => models.find((m) => m.id === id)!;

  it('describes each recipe in generic terms', () => {
    expect(model('h3-video')).toMatchObject({
      kind: 'video',
      inputs: { prompt: 'required', image: 'optional', end_image: 'optional', audio: 'optional' },
      duration: { min: 1, max: 15 },
      qualities: ['draft', 'final'],
    });
    expect(model('h3-video').inputs.reference_images).toBeUndefined();
    expect(model('h3-reference')).toMatchObject({ inputs: { reference_images: 'optional', voice_reference: 'optional' }, max_reference_images: 4 });
    expect(model('qwen-image-edit').inputs).toMatchObject({ image: 'required', reference_images: 'optional' });
    expect(model('flux2-klein-edit').max_reference_images).toBe(1);
    expect(model('seedvr2-upscale-image').inputs.prompt).toBeUndefined();
  });

  it("maps generic fields onto each recipe's own parameters", () => {
    const h3 = mapRequest(store.require('h3-video'), {
      prompt: 'a walk',
      image: 'a.png',
      end_image: 'b.png',
      duration: 8,
      aspect_ratio: '9:16',
      quality: 'draft',
    });
    expect(h3.mode).toBe('draft');
    expect(h3.params).toMatchObject({ prompt: 'a walk', first_frame: 'a.png', last_frame: 'b.png', duration: 8 });
    expect((h3.params.width as number) < (h3.params.height as number)).toBe(true);
    expect(() => mapRequest(store.require('h3-video'), { prompt: 'x', duration: 20 })).toThrow(/1-15 s.*render_shots/);

    expect(mapRequest(store.require('qwen-image-edit'), { prompt: 'x', image: 'a.png', reference_images: ['r.png'] }).params.images).toEqual(['a.png', 'r.png']);
    expect(mapRequest(store.require('flux2-klein-edit'), { prompt: 'x', image: 'a.png', reference_images: ['r.png'] }).params).toMatchObject({ image: 'a.png', reference: 'r.png' });
    // An image-to-video model given only references starts from the first.
    expect(mapRequest(store.require('infinitetalk'), { prompt: 'x', reference_images: ['p.png'], audio: 'v.wav' }).params).toMatchObject({ image: 'p.png', audio: 'v.wav' });

    const tts = store.require('qwen3-tts');
    expect(mapRequest(tts, { prompt: 'Hello.', voice: 'serena' })).toMatchObject({ mode: 'preset', params: { text: 'Hello.', speaker: 'Serena' } });
    expect(mapRequest(tts, { prompt: 'Hello.', voice: 'a warm, slow old man' })).toMatchObject({ mode: 'design', params: { voice: 'a warm, slow old man' } });
    expect(mapRequest(tts, { prompt: 'Hello.', voice_reference: 'me.wav' })).toMatchObject({ mode: 'final', params: { voice_ref: 'me.wav' } });
  });

  it('picks the best installed model that takes every input given', () => {
    expect(pickModel('video', { prompt: 'x', reference_images: ['a.png', 'b.png'] }, models).id).toBe('h3-reference');
    expect(pickModel('video', { prompt: 'x', image: 'a.png', audio: 'v.wav' }, models).id).toBe('h3-video');
    expect(pickModel('video', { prompt: 'x', image: 'a.png', audio: 'v.wav', audio_2: 'w.wav' }, models).id).toBe('infinitetalk-duo');
    expect(pickModel('image', { image: 'a.png' }, models).id).toBe('seedvr2-upscale-image');
    expect(pickModel('audio', { prompt: 'x', lyrics: 'la la' }, models, 'music').capabilities).toContain('music');
    // A model verified on a GPU wins over an unverified one that ranks higher.
    const verifiedFirst = [{ ...model('krea2-image'), verified: undefined }, { ...model('zimage-turbo'), verified: { date: 'd', gpu: 'g' } }];
    expect(pickModel('image', { prompt: 'x' }, verifiedFirst).id).toBe('zimage-turbo');
    const none = models.map((m) => ({ ...m, unavailable: 'not installed' }));
    expect(() => pickModel('video', { prompt: 'x' }, none)).toThrow(/No video model.*not installed/);
  });
});

describe('recipe uninstall', () => {
  it('frees files shared only with recipes that use nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-pro-recipes-'));
    const audio = JSON.parse(await readFile(join(FIXTURES, 'test-audio', 'recipe.json'), 'utf8'));
    const variant = (path: string) => [{ repo: 'example/none', path, bytes: 10 }];
    for (const [id, own] of [['share-a', 'a.safetensors'], ['share-b', 'b.safetensors']]) {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, 'workflow.json'), await readFile(join(FIXTURES, 'test-audio', 'workflow.json')));
      const files = [
        { id: 'shared', folder: 'checkpoints', label: 'Shared', variants: variant('shared.safetensors') },
        { id: 'own', folder: 'checkpoints', label: 'Own', variants: variant(own) },
      ];
      await writeFile(join(dir, id, 'recipe.json'), JSON.stringify({ ...audio, id, files }));
    }
    const server = await buildServer(await tempConfig({ RECIPES_DIR: dir }));
    try {
      const install = async (id: string, which: string[]) => {
        for (const f of await server.recipes.resolveFiles(server.recipes.require(id), '32gb')) {
          if (!which.includes(f.file.id)) continue;
          await mkdir(join(f.path, '..'), { recursive: true });
          await writeFile(f.path, 'x');
        }
      };
      // Only A is installed; B merely resolves to the shared file. Deleting A frees both.
      await install('share-a', ['shared', 'own']);
      let res = (await server.app.inject({ method: 'DELETE', url: '/v1/recipes/share-a' })).json();
      expect(res.deleted).toHaveLength(2);
      expect(res.kept).toEqual([]);
      // Both installed: deleting A keeps the file B still needs.
      await install('share-a', ['shared', 'own']);
      await install('share-b', ['own']);
      // The plan says so first: which file is shared, with whom, and what each choice frees.
      const plan = (await server.app.inject({ method: 'GET', url: '/v1/recipes/share-a/delete-plan' })).json();
      expect(plan.files).toEqual([
        { path: 'checkpoints/shared.safetensors', label: 'Shared', bytes: 1, shared_with: ['share-b'] },
        { path: 'checkpoints/a.safetensors', label: 'Own', bytes: 1, shared_with: [] },
      ]);
      expect(plan).toMatchObject({ own_bytes: 1, shared_bytes: 1 });
      res = (await server.app.inject({ method: 'DELETE', url: '/v1/recipes/share-a' })).json();
      expect(res.deleted).toEqual(['checkpoints/a.safetensors']);
      expect(res.kept).toEqual(['checkpoints/shared.safetensors']);
      expect(res).toMatchObject({ freed_bytes: 1, affected: [] });
      // Asked to, it deletes the shared file too, and names the recipe that loses it.
      await install('share-a', ['own']);
      res = (await server.app.inject({ method: 'DELETE', url: '/v1/recipes/share-a?shared=delete' })).json();
      expect(res.deleted.sort()).toEqual(['checkpoints/a.safetensors', 'checkpoints/shared.safetensors']);
      expect(res).toMatchObject({ kept: [], freed_bytes: 2, affected: ['share-b'] });
      expect((await server.app.inject({ method: 'GET', url: '/v1/recipes/share-b' })).json().state).toBe('partial');
      // The listing carries the storage indicator's figures (the filesystem's, with no volume size set).
      const list = (await server.app.inject({ method: 'GET', url: '/v1/recipes' })).json();
      expect(list.storage).toMatchObject({ source: 'filesystem' });
      expect(list.storage.totalBytes).toBeGreaterThan(0);
      expect(list.downloading_bytes).toBe(0);
    } finally {
      await server.app.close();
      server.closeDb();
    }
  });
});

describe('api', () => {
  let server: ProServer;
  beforeAll(async () => {
    server = await buildServer(await tempConfig());
  });
  afterAll(async () => {
    await server.app.close();
    server.closeDb();
  });
  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    server.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  it('lists recipes with install state and licence', async () => {
    const response = await inject('GET', '/v1/recipes');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tier).toBe('32gb');
    const audio = body.recipes.find((r: { id: string }) => r.id === 'test-audio');
    expect(audio).toMatchObject({ state: 'installed', licence: { commercial: 'no' } });
    expect(audio.files[0]).toMatchObject({ folder: 'checkpoints', installed: false, optional: true });
  });

  it('plans a project from its script with a local model', async () => {
    const project = server.projects.createProject({ name: 'Scripted', script: 'INT. KITCHEN. Mia makes tea and says hello.' });
    const refused = await inject('POST', '/v1/analyze', { task: 'plan', project_id: server.projects.createProject({ name: 'Empty' }).id });
    expect(refused.statusCode).toBe(400);
    const plan = {
      assets: [{ ref: 'mia', kind: 'character', name: 'Mia', description: 'thirties, short black hair, green cardigan' }],
      scenes: [{ title: 'Kitchen', shots: [{ kind: 'dialogue', duration_s: 5, prompt: 'Mia pours tea', dialogue: [{ speaker: 'mia', line: 'Hello.' }], assets: ['mia'] }] }],
    };
    let asked: { response_format?: unknown } = {};
    const engine = new AnalyzeEngine({
      config: { ...(await tempConfig()), planModel: 'stub' },
      paths: server.paths,
      projects: server.projects,
      recipes: server.recipes,
      goldenPath: (f) => f,
      log,
      text: {
        generate: async ({ params }: { params: { response_format?: unknown } }) => {
          asked = params;
          return { text: JSON.stringify(plan), durationMs: 1, params };
        },
      } as never,
    });
    const run = engine.executors().analyze!;
    const result = await run({ job: { params: { task: 'plan', project_id: project.id } }, signal: new AbortController().signal, onLog: () => {} } as never);
    expect(result).toMatchObject({ scenes: 1, shots: 1, assets: 1 });
    expect(asked.response_format).toMatchObject({ type: 'json_schema' });
    const full = server.projects.getProject(project.id);
    const shot = full.scenes[0].shots[0];
    // The speaker ref became the new asset's id.
    expect(shot.dialogue).toEqual([{ asset_id: full.assets[0].id, line: 'Hello.' }]);
  });

  it('refuses an install that would not fit, counting queued downloads', async () => {
    const response = await inject('GET', '/v1/recipes/test-audio');
    // Its one file is optional: not needed to run, but Install fetches it.
    expect(response.json()).toMatchObject({ missing_bytes: 0, install_bytes: 10 });

    // A 1 MB volume has no room once 2 GB is held back for the database.
    const small = await buildServer(await tempConfig({ DATA_VOLUME_GB: '0.001' }));
    try {
      const refused = await small.app.inject({ method: 'POST', url: '/v1/recipes/test-audio/install', payload: {} });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(refused.json().error.message).toMatch(/Not enough room on the data volume: Test audio needs/);
      expect(small.downloads.list()).toHaveLength(0);
    } finally {
      await small.app.close();
      small.closeDb();
    }

    // A queued download's expected size is space already spoken for.
    const queued = await server.downloads.enqueue({
      kind: 'comfy',
      bundle: 'checkpoints',
      slot: 'file',
      url: 'https://example.invalid/never.safetensors',
      name: 'never.safetensors',
      expectedBytes: 5e9,
    });
    expect(server.downloads.pendingBytes()).toBeGreaterThanOrEqual(5e9);
    expect(server.downloads.pendingBytes(queued.id)).toBeLessThan(5e9);
    // It can never finish (the host does not exist); stop it if it has not failed already.
    try {
      server.downloads.cancel(queued.id);
    } catch {
      // already failed
    }
    // Wait for it to settle: its runner pumps the queue as it ends, which
    // after the suite closes the database is an unhandled rejection.
    for (let i = 0; i < 100 && !['failed', 'cancelled'].includes(server.downloads.get(queued.id)?.status ?? ''); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it('generates in generic terms, fetching media from a URL', async () => {
    const models = (await inject('GET', '/v1/models?kind=video')).json().models;
    expect(models.find((m: { id: string }) => m.id === 'test-video')).toMatchObject({
      inputs: { prompt: 'optional' },
      duration: { min: 0.5, max: 5 },
      installed: true,
    });

    const job = (await inject('POST', '/v1/generate', { kind: 'video', model: 'test-video', prompt: 'red', duration: 2, aspect_ratio: '9:16' })).json();
    expect(job).toMatchObject({ model: 'test-video', quality: 'draft' });
    const params = server.jobs.get(job.jobs[0].id)!.params as { params: Record<string, number> };
    expect(params.params.duration).toBe(2);
    expect(params.params.width).toBeLessThan(params.params.height);
    // Cancelled, and let settle, so nothing writes after the server closes.
    const stop = async (id: string) => {
      server.jobs.cancel(id);
      for (let i = 0; i < 100 && ['queued', 'running'].includes(server.jobs.get(id)!.status); i++) await new Promise((r) => setTimeout(r, 20));
    };
    await stop(job.jobs[0].id);

    // An input the model does not take is refused with the reason.
    const refused = await inject('POST', '/v1/generate', { kind: 'video', model: 'test-video', prompt: 'x', audio: 'a.wav' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/does not take audio/);

    // A reference image by URL is fetched into uploads.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { createServer } = await import('node:http');
    const http = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    try {
      const image = (await inject('POST', '/v1/generate', { kind: 'image', model: 'test-image', reference_images: [`http://127.0.0.1:${port}/ref`] })).json();
      const refs = (server.jobs.get(image.jobs[0].id)!.params as { params: { refs: string[] } }).params.refs;
      expect(refs).toHaveLength(1);
      expect((await stat(join(server.paths.uploadsDir, refs[0]))).size).toBe(png.length);
      await stop(image.jobs[0].id);
    } finally {
      http.close();
    }
  });

  it('refuses a bad recipe request before queueing', async () => {
    expect((await inject('POST', '/v1/jobs', { recipe: 'nope' })).statusCode).toBe(404);
    const bad = await inject('POST', '/v1/jobs', { recipe: 'test-image', params: { width: 2 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/width/);
    const missing = await inject('POST', '/v1/jobs', { recipe: 'test-image', params: { refs: ['nope.png'] } });
    expect(missing.json().error.code).toBe('INPUT_NOT_FOUND');
  });

  it('plans a project, derives a shot request and renders takes as jobs', async () => {
    const project = (await inject('POST', '/v1/projects', { name: 'Rain', aspect: '16:9' })).json();
    const planned = await inject('POST', `/v1/projects/${project.id}/plan`, {
      style: 'Neon noir.',
      assets: [{ ref: 'mei', kind: 'character', name: 'Mei', description: 'A courier in a yellow coat' }],
      scenes: [
        {
          title: 'Alley',
          shots: [
            { prompt: 'Mei runs through the alley.', duration_s: 2, recipe: 'test-video', sound: 'footsteps' },
            { prompt: 'Mei stops.', dialogue: [{ speaker: 'mei', line: 'Who is there?' }], recipe: 'test-video' },
          ],
        },
      ],
    });
    expect(planned.statusCode).toBe(200);
    const plan = planned.json();
    expect(plan.shots).toHaveLength(2);
    expect(plan.shots[1]).toMatchObject({ kind: 'dialogue', assetIds: [plan.assets[0].id] });

    const request = (await inject('GET', `/v1/shots/${plan.shots[1].id}/request`)).json();
    expect(request.recipe).toBe('test-video');
    expect(request.params.prompt).toContain('Mei says exactly this: "Who is there?"');
    expect(request.params.width).toBeGreaterThan(request.params.height);

    const rendered = await inject('POST', '/v1/shots/render', { shot_ids: [plan.shots[0].id], count: 2 });
    expect(rendered.statusCode).toBe(202);
    const takes = rendered.json().takes;
    expect(takes).toHaveLength(2);
    expect(takes[0].seed).not.toBe(takes[1].seed);
    for (const take of takes) server.jobs.cancel(take.jobId);

    const full = (await inject('GET', `/v1/projects/${project.id}`)).json();
    expect(full.scenes[0].shots[0].takes).toHaveLength(2);

    const moved = await inject('PATCH', `/v1/shots/${plan.shots[1].id}`, { position: 0 });
    expect(moved.json().position).toBe(0);
    const cut = await inject('POST', `/v1/projects/${project.id}/cuts`, {});
    expect(cut.json().items).toEqual([]);
    expect((await inject('POST', `/v1/cuts/${cut.json().id}/export`)).statusCode).toBe(400);
  });

  it('holds a commercial project to commercial licences on a personal server', async () => {
    const make = async (licenceMode: string) => {
      const project = (await inject('POST', '/v1/projects', { name: `Ad ${licenceMode}`, licenceMode })).json();
      const plan = (
        await inject('POST', `/v1/projects/${project.id}/plan`, { scenes: [{ shots: [{ prompt: 'A jingle.', recipe: 'test-audio' }] }] })
      ).json();
      return inject('POST', '/v1/shots/render', { shot_ids: [plan.shots[0].id] });
    };
    const refused = await make('commercial');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/project is marked commercial/);
    const allowed = await make('personal');
    expect(allowed.statusCode).toBe(202);
    for (const take of allowed.json().takes) server.jobs.cancel(take.jobId);
  });

  it('checks analysis requests before queueing them', async () => {
    expect((await inject('POST', '/v1/analyze', { task: 'check' })).statusCode).toBe(400);
    expect((await inject('POST', '/v1/analyze', { task: 'beats' })).statusCode).toBe(400);
    expect((await inject('POST', '/v1/analyze', { task: 'beats', asset_id: 'nope' })).statusCode).toBe(400);
    // Without a check model the job fails with what to do about it.
    const project = (await inject('POST', '/v1/projects', { name: 'Check' })).json();
    const plan = (await inject('POST', `/v1/projects/${project.id}/plan`, { scenes: [{ shots: [{ prompt: 'x', recipe: 'test-video' }] }] })).json();
    const { takes } = (await inject('POST', '/v1/shots/render', { shot_ids: [plan.shots[0].id] })).json();
    server.jobs.cancel(takes[0].jobId);
    const job = (await inject('POST', '/v1/analyze', { task: 'check', take_id: takes[0].id })).json();
    for (let i = 0; i < 50 && ['queued', 'running'].includes(server.jobs.get(job.id)!.status); i++) await new Promise((r) => setTimeout(r, 20));
    expect(server.jobs.get(job.id)!.error?.message).toMatch(/CHECK_MODEL|no finished file/);
  });

  it('generates over MCP in generic terms and follows several jobs at once', async () => {
    const mcp = (method: string, params: unknown) =>
      server.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method, params },
      });
    const generated = (await mcp('tools/call', { name: 'generate_video', arguments: { model: 'test-video', prompt: 'red', count: 2 } })).json().result;
    expect(generated.isError).toBeFalsy();
    expect(JSON.parse(generated.content[0].text)).toEqual({ model: 'test-video', quality: 'draft' });
    const ids = generated.structuredContent.jobs.map((j: { id: string }) => j.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) server.jobs.cancel(id);
    const followed = (await mcp('tools/call', { name: 'get_job', arguments: { ids, wait_seconds: 5 } })).json().result;
    expect(followed.structuredContent.jobs.map((j: { id: string }) => j.id)).toEqual(ids);
    for (let i = 0; i < 100 && ids.some((id: string) => ['queued', 'running'].includes(server.jobs.get(id)!.status)); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it('answers MCP tool listing with the Pro tools', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    const names = response.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'pro_status',
        'list_models',
        'install_model',
        'generate_image',
        'generate_video',
        'generate_audio',
        'plan_project',
        'render_shots',
        'get_project',
        'analyze',
        'get_job',
        'add_input',
        'get_logs',
      ]),
    );
  });
});

/**
 * End to end against a real ComfyUI: set COMFY_TEST_DIR (a ComfyUI checkout)
 * and COMFY_TEST_PYTHON (its interpreter). CPU is enough — the test recipes
 * load no models. Skipped otherwise.
 */
const COMFY_DIR = process.env.COMFY_TEST_DIR;
const COMFY_PYTHON = process.env.COMFY_TEST_PYTHON;
const haveComfy = Boolean(COMFY_DIR && COMFY_PYTHON && existsSync(join(COMFY_DIR, 'main.py')));
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!haveComfy)('comfyui end to end', () => {
  let server: ProServer;
  beforeAll(async () => {
    const config = await tempConfig({
      COMFY_DIR: COMFY_DIR!,
      COMFY_PYTHON: COMFY_PYTHON!,
      COMFY_PORT: '8199',
      COMFY_RECYCLE_JOBS: '0',
    });
    server = await buildServer(config);
    // CPU only: there is no GPU in the test environment.
    await server.backends.updateArgs('comfy', { values: { cpu: true }, extraArgs: [] });
  }, 60_000);
  afterAll(async () => {
    await server?.engines.shutdown();
    await server?.backends.stopAll();
    await server?.app.close();
    server?.closeDb();
  });

  async function settle(id: string, timeoutMs = 240_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const job = server.jobs.get(id)!;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${id} did not settle`);
  }

  it('runs an image recipe with a reference, and prunes when it has none', async () => {
    const png = await readFile(fileURLToPath(new URL('./fixtures/pixel.png', import.meta.url))).catch(() => null);
    const upload = 'ref.png';
    if (png) await writeFile(join(server.paths.uploadsDir, upload), png);
    const job = server.jobs.create('image', {
      recipe: 'test-image',
      mode: 'draft',
      params: resolveParams(server.recipes.require('test-image'), server.recipes.require('test-image').modes.draft, png ? { refs: [upload] } : {}),
    });
    const done = await settle(job.id);
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('completed');
    const path = done.result!.image_path as string;
    expect((await stat(path)).size).toBeGreaterThan(0);
    expect(done.result!.metadata).toMatchObject({ recipe: 'test-image', mode: 'draft' });

    const bare = await settle(server.jobs.create('image', { recipe: 'test-image', mode: 'final', params: { width: 48, height: 48, color: 255, seed: 1 } }).id);
    expect(bare.status).toBe('completed');
  }, 300_000);

  it('runs video and audio recipes and keeps a take in its project', async () => {
    const project = server.projects.createProject({ name: 'E2E' });
    const scene = server.projects.createScene(project.id);
    const shot = server.projects.createShot(scene.id, { prompt: 'red', recipeId: 'test-video', durationS: 1 });
    const [take] = await server.projects.renderShots([shot.id], { count: 1 });
    const job = await settle(take.jobId);
    expect(job.error).toBeUndefined();
    expect(job.result!.video_url).toMatch(/\.mp4$/);
    await new Promise((r) => setTimeout(r, 300));
    const kept = server.projects.requireTake(take.id).file!;
    expect(kept).toMatch(/\.mp4$/);
    expect((await stat(server.projects.takeFile(project.id, kept))).size).toBeGreaterThan(0);

    // The same prompt again is a ComfyUI cache hit; it must still write a file
    // of its own rather than report the one the first take already moved.
    const [again] = await server.projects.renderShots([shot.id], { count: 1, fromTake: take.id });
    const repeat = await settle(again.jobId);
    expect(repeat.error).toBeUndefined();
    expect(repeat.result!.video_url).not.toBe(job.result!.video_url);

    const audio = await settle(server.jobs.create('audio', { recipe: 'test-audio', params: { duration: 0.5 } }).id);
    expect(audio.status).toBe('completed');
    expect(audio.result!.audio_url).toBeDefined();

    if (haveFfmpeg) {
      server.projects.chooseTake(take.id);
      const cut = server.projects.createCut(project.id, { subtitles: false });
      expect(cut.items).toHaveLength(1);
      const render = await settle(server.projects.exportCut(cut.id).id);
      expect(render.error).toBeUndefined();
      expect(render.result!.metadata).toMatchObject({ width: 1080, height: 1920, takes: 1 });
    }
  }, 300_000);

  it('renders a long take as chained segments and retakes its end', async () => {
    if (!haveFfmpeg) return;
    const project = server.projects.createProject({ name: 'Long' });
    const scene = server.projects.createScene(project.id);
    // test-continue renders 1.5 s at most with 0.25 s of overlap: 3 s is three segments.
    const shot = server.projects.createShot(scene.id, { prompt: 'blue', recipeId: 'test-continue', durationS: 3 });
    const [take] = await server.projects.renderShots([shot.id], { count: 1 });
    expect(take.chain).toMatchObject({ kind: 'long', segments: [{ duration: 1.5 }, { duration: 1.5 }, { duration: 0.5 }] });
    const settleTake = async (id: string) => {
      for (let i = 0; i < 1200; i++) {
        const view = server.projects.viewTake(server.projects.requireTake(id));
        if (view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled') return view;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`take ${id} did not settle`);
    };
    const long = await settleTake(take.id);
    expect(long.error).toBeUndefined();
    expect(long.chain).toMatchObject({ state: 'done', index: 2 });
    // Each continuing segment was given the one before it.
    const second = server.jobs.get(long.chain!.segments[1].jobId!)!;
    expect((second.params as { params: Record<string, unknown> }).params.previous).toBe(long.chain!.segments[0].upload);
    const joined = await probeMedia(server.projects.takeFile(project.id, long.file!));
    expect(joined.duration).toBeGreaterThan(2.4);
    expect(joined.hasAudio).toBe(true);

    const retake = await server.projects.retake(take.id, { from: 2 });
    expect(retake.chain).toMatchObject({ kind: 'retake', from: 2, sourceTakeId: take.id });
    const redone = await settleTake(retake.id);
    expect(redone.error).toBeUndefined();
    expect(redone.file).toBe(`${retake.id}.mp4`);
    const first = server.jobs.get(redone.chain!.segments[0].jobId!)!;
    expect((first.params as { params: Record<string, unknown> }).params.previous).toBe(redone.chain!.head);
    await expect(server.projects.retake(take.id, { from: 0.1 })).rejects.toThrow(/Retake from between/);
  }, 300_000);

  it('finds the beats of a track and stores them on its asset', async () => {
    if (!haveFfmpeg) return;
    const name = 'clicks.wav';
    // Ten seconds of clicks at 120 bpm.
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,sin(2*PI*1000*t)\\,0):s=22050:d=10', join(server.paths.uploadsDir, name)]);
    const project = server.projects.createProject({ name: 'Beat' });
    const asset = server.projects.createAsset(project.id, { kind: 'audio', name: 'Clicks', audio: name });
    const job = await settle(server.jobs.create('analyze', { task: 'beats', asset_id: asset.id }).id);
    expect(job.error).toBeUndefined();
    expect(job.result!.bpm).toBeGreaterThan(110);
    expect(job.result!.bpm).toBeLessThan(130);
    const beats = (server.projects.requireAsset(asset.id).meta as { beats: { beats: number[] } }).beats.beats;
    expect(beats.length).toBeGreaterThan(12);
  }, 120_000);

  it('renders golden shots per version and compares two versions blind', async () => {
    const run = server.golden.start('test-video');
    const settleRun = async (id: string) => {
      for (let i = 0; i < 600; i++) {
        const found = server.golden.listRuns('test-video').find((r) => r.id === id)!;
        if (found.status === 'done' || found.status === 'failed') return found;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('golden run did not finish');
    };
    const first = await settleRun(run.id);
    expect(first.status).toBe('done');
    const completed = first.results.filter((r) => r.status === 'completed');
    expect(completed.map((r) => r.shotId)).toContain('drama-action');
    // Shots that need a portrait are skipped: no installed recipe here can make one.
    expect(first.results.find((r) => r.shotId === 'drama-closeup')).toMatchObject({ status: 'skipped', error: expect.stringMatching(/text-to-image/) });
    expect((await stat(server.golden.resultPath(completed[0].file!))).size).toBeGreaterThan(0);

    // A new version of the recipe, compared shot by shot against the old.
    server.recipes.require('test-video').version = 2;
    await settleRun(server.golden.start('test-video').id);
    server.recipes.require('test-video').version = 1;
    // The fixture has only a draft mode, so that is what golden runs use.
    const pair = server.golden.pair('test-video', 'draft');
    expect(pair).toMatchObject({ done: false, remaining: completed.length });
    if (!pair || pair.done) throw new Error('expected a pair');
    const vote = server.golden.vote({ recipe: 'test-video', mode: 'draft', shot: pair.shot, left: pair.left.token, right: pair.right.token, winner: 'left' });
    expect(new Set([vote.left, vote.right])).toEqual(new Set([1, 2]));
    const tally = server.golden.tally('test-video');
    expect(tally.find((t) => t.version === vote.winner)).toMatchObject({ wins: 1 });
  }, 300_000);

  it('transcribes a take and keeps the verdict on it', async () => {
    const project = server.projects.createProject({ name: 'Words' });
    const scene = server.projects.createScene(project.id);
    const shot = server.projects.createShot(scene.id, { prompt: 'x', recipeId: 'test-video', durationS: 1 });
    const [take] = await server.projects.renderShots([shot.id], { count: 1 });
    await settle(take.jobId);
    await new Promise((r) => setTimeout(r, 300));
    // The fixture take is silent, so Whisper hears nothing of the expected line.
    const job = await settle(server.jobs.create('analyze', { task: 'transcribe', take_id: take.id, expected: 'Hello there' }).id);
    expect(job.error).toBeUndefined();
    expect(job.result!.match).toMatchObject({ ok: false });
    expect(server.projects.requireTake(take.id).review).toMatchObject({ ok: false, model: 'whisper-base' });
  }, 300_000);

  it('cancels a running prompt through ComfyUI', async () => {
    const recipe = server.recipes.require('test-video');
    const job = server.jobs.create('video', { recipe: 'test-video', params: { ...resolveParams(recipe, recipe.modes.draft, {}), width: 512, height: 512, duration: 5 } });
    await new Promise((r) => setTimeout(r, 1500));
    server.jobs.cancel(job.id);
    const done = await settle(job.id);
    expect(['cancelled', 'completed']).toContain(done.status);
  }, 120_000);
});
