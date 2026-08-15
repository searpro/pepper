#!/usr/bin/env node
/**
 * Validates `pepper-catalogue.json`.
 *
 * Two levels, because they fail for different reasons and at different speeds:
 *
 *   node validate.mjs          structure only — offline, instant
 *   node validate.mjs --live   also resolves every source against HuggingFace
 *
 * The live check is the one that matters in practice. A structurally perfect
 * entry pointing at a repo that was renamed, gated, or never existed produces
 * an install that fails *after* the user has chosen a quantization, which is
 * the worst moment to discover it. Run it in CI on a schedule, not only on
 * push: these repos change under you.
 *
 * Deliberately dependency-free so it runs in a bare checkout with no install
 * step.
 */

import { readFile } from 'node:fs/promises';

const KINDS = new Set(['image', 'video', 'audio', 'llm']);
const KNOWN_SLOTS = new Set(['checkpoint', 'vae', 'clip', 'lora', 'weights', 'aux']);
const CLIP_ROLES = new Set(['clip_l', 'clip_g', 'clip_vision', 't5xxl', 'llm', 'llm_vision']);

const live = process.argv.includes('--live');
const errors = [];
const warnings = [];

const fail = (where, message) => errors.push(`${where}: ${message}`);
const warn = (where, message) => warnings.push(`${where}: ${message}`);

const catalogue = JSON.parse(await readFile(new URL('./pepper-catalogue.json', import.meta.url), 'utf8'));

if (typeof catalogue.version !== 'number') fail('root', '"version" must be a number');
if (!Array.isArray(catalogue.models)) {
  fail('root', '"models" must be an array');
  report();
}

const seen = new Set();

for (const model of catalogue.models) {
  const where = `models/${model.id ?? '<no id>'}`;

  if (!model.id) fail(where, 'missing "id"');
  if (!model.name) fail(where, 'missing "name"');
  if (!KINDS.has(model.kind)) fail(where, `"kind" must be one of ${[...KINDS].join(', ')}`);

  // A duplicate makes "install this one" ambiguous, and the server rejects the
  // whole document for it — better to catch it here.
  const key = `${model.kind}/${model.id}`;
  if (seen.has(key)) fail(where, `duplicate id "${key}"`);
  seen.add(key);

  // audio.cpp cannot register a bundle without these, and neither is derivable
  // from the files, so an audio entry missing them installs something unusable.
  if (model.kind === 'audio') {
    if (!model.family) fail(where, 'audio models must declare "family" (audio.cpp model_specs/<family>.json)');
    if (!model.task) fail(where, 'audio models must declare "task" (tts | asr | …)');
  }

  if ((model.kind === 'image' || model.kind === 'video') && !model.loadMode) {
    warn(where, 'no "loadMode" — the server will auto-detect, which can guess wrong on split checkpoints');
  }
  if (model.kind === 'video' && model.mode !== 'video') {
    fail(where, 'video models must set "mode": "video", or they generate a single frame');
  }

  if (!Array.isArray(model.components) || model.components.length === 0) {
    fail(where, 'needs at least one component');
    continue;
  }

  let required = 0;
  for (const [index, component] of model.components.entries()) {
    const cw = `${where}/components[${index}]`;

    if (!component.label) fail(cw, 'missing "label"');
    if (!component.slot) fail(cw, 'missing "slot"');
    else if (!KNOWN_SLOTS.has(component.slot) && !component.slot.startsWith('other:')) {
      fail(cw, `unknown slot "${component.slot}"`);
    }
    if (component.role && !CLIP_ROLES.has(component.role)) {
      fail(cw, `unknown role "${component.role}"`);
    }
    if (component.slot === 'clip' && !component.role) {
      warn(cw, 'clip component without a "role" relies on filename detection');
    }
    if (component.required) required++;

    const source = component.source;
    if (!source) {
      fail(cw, 'missing "source"');
      continue;
    }
    if (!source.repo && !source.url) fail(cw, 'source needs "repo" or "url"');
    if (source.repo && !/^[\w.-]+\/[\w.-]+$/.test(source.repo)) {
      fail(cw, `"repo" must look like owner/name, got "${source.repo}"`);
    }
    if (source.extensions && !Array.isArray(source.extensions)) {
      fail(cw, '"extensions" must be an array');
    }
  }

  if (required === 0) warn(where, 'no component is marked "required" — nothing is pre-selected on install');
}

if (live) await checkLive();

report();

async function checkLive() {
  // The same filters the server applies, so this reports what a user would
  // actually be offered rather than the raw file list.
  const SHARD_RE = /-\d{5}-of-\d{5}\.[a-z]+$/;
  const DRAFT_PREFIXES = ['mtp-', 'dflash-', 'dspark-', 'eagle3-'];
  const DEFAULT_EXTENSIONS = ['.gguf', '.safetensors', '.bin', '.pt', '.ckpt', '.json', '.txt'];

  for (const model of catalogue.models) {
    for (const [index, component] of (model.components ?? []).entries()) {
      const cw = `${model.id}/components[${index}] (${component.slot})`;
      const source = component.source ?? {};
      if (source.url || !source.repo) continue;

      const url = `https://huggingface.co/api/models/${source.repo}/tree/main${
        source.path ? `/${source.path}` : ''
      }?recursive=false`;

      let entries;
      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'pepper-catalogue-validate' } });
        if (!response.ok) {
          fail(cw, `HuggingFace returned ${response.status} for ${source.repo}${source.path ? `/${source.path}` : ''}`);
          continue;
        }
        entries = await response.json();
      } catch (err) {
        fail(cw, `could not reach HuggingFace: ${err.message}`);
        continue;
      }

      const extensions = source.extensions ?? DEFAULT_EXTENSIONS;
      const match = source.match?.toLowerCase();
      const wantsProjector = component.role === 'llm_vision' || (match?.includes('mmproj') ?? false);

      const offered = entries
        .filter((entry) => entry.type === 'file')
        .map((entry) => entry.path.split('/').pop() ?? entry.path)
        .filter((name) => {
          const lower = name.toLowerCase();
          if (!extensions.some((ext) => lower.endsWith(ext))) return false;
          if (match && !lower.includes(match)) return false;
          if (SHARD_RE.test(lower)) return false;
          if (DRAFT_PREFIXES.some((prefix) => lower.startsWith(prefix)) || lower.includes('-draft')) return false;
          if (!wantsProjector && lower.includes('mmproj')) return false;
          return true;
        });

      if (offered.length === 0) {
        const message = `resolves to 0 installable files in ${source.repo}${source.path ? `/${source.path}` : ''}`;
        if (component.required) fail(cw, message);
        else warn(cw, message);
      } else {
        console.log(`  ok  ${cw} → ${offered.length} file(s)`);
      }
    }
  }
}

function report() {
  for (const warning of warnings) console.warn(`warn  ${warning}`);
  for (const error of errors) console.error(`FAIL  ${error}`);

  const models = catalogue.models?.length ?? 0;
  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s) in ${models} model(s).`);
    process.exit(1);
  }
  console.log(`\nOK — ${models} models valid${live ? ', all sources resolve' : ''}.`);
  process.exit(0);
}
