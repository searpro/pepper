import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { readOverrides } from '@pepper/core/backends/args.js';
import type { BackendManager } from '@pepper/core/backends/manager.js';
import type { SettingsStore } from '@pepper/core/db/settings.js';
import type { ProConfig } from '../config.js';
import type { ProPaths } from '../paths.js';

/**
 * The model Claude Code runs on when it is pointed at this server
 * (`LLM_AGENT_MODEL`), as one preset of llama.cpp's router: `/v1/messages`
 * sends every request to it whatever model name the client asked for.
 *
 * On a 16 GB card it is stopped for every render and started again for the
 * next turn, which would throw away the processed conversation each time —
 * 11 s of prefill for a 26k-token Claude Code context. So its slot is saved
 * to disk before llama.cpp stops (`save`, the backend's before-stop hook)
 * and restored before the first request after a start (`prepare`); the next
 * turn then costs only the model load.
 */

export const AGENT_MODEL_ID = 'agent';

/**
 * What the agent preset runs with unless `LLM_AGENT_ARGS` says otherwise:
 * measured on the home box (RTX 5060 Ti 16 GB) with Qwen3.6-35B-A3B Q4_K_M,
 * which then holds ~14.8 GB. One slot, since a second would halve the context
 * and Claude Code works one turn at a time.
 */
export const AGENT_DEFAULT_ARGS =
  '--ctx-size 98304 --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on ' +
  '--batch-size 4096 --ubatch-size 4096 --parallel 1 --cache-ram 8192 --jinja';

/**
 * `--key value` / `--flag` pairs as a preset's `key = value` lines. Long
 * flags only: the router's preset keys are the long names, and a short one
 * would be silently ignored.
 */
export function parseLongFlags(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) {
      throw new Error(`LLM_AGENT_ARGS: "${token}" is not a long flag (write --ctx-size, not -c)`);
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[token.slice(2)] = next;
      i++;
    } else {
      out[token.slice(2)] = '1';
    }
  }
  return out;
}

/**
 * The model file and its vision projector for `LLM_AGENT_MODEL`, a path under
 * the LLM folder: a GGUF, or a bundle folder holding one. The projector is
 * the bundle's `mmproj-*.gguf`, or, beside a loose file, the `mmproj-<prefix
 * of its name>.gguf`.
 */
export function resolveAgentModel(llmDir: string, agentModel: string): { model: string; mmproj?: string } {
  const target = join(llmDir, agentModel);
  const isDir = statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
  const dir = isDir ? target : dirname(target);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.gguf'));
  } catch {
    names = [];
  }
  const projectors = names.filter((n) => n.startsWith('mmproj-'));
  const model = isDir ? names.find((n) => !n.startsWith('mmproj-')) : basename(target);
  if (!model) throw new Error(`LLM_AGENT_MODEL: no GGUF model in ${target}`);
  const stem = basename(model, '.gguf');
  const mmproj =
    dir !== llmDir
      ? projectors[0]
      : projectors
          .filter((n) => stem.startsWith(n.slice('mmproj-'.length, -'.gguf'.length)))
          .sort((a, b) => b.length - a.length)[0];
  return { model: join(dir, model), mmproj: mmproj && join(dir, mmproj) };
}

/**
 * The router's preset: `globals` for every model (what would otherwise be the
 * router's own flags, which beat any preset), then the agent's section.
 */
export function presetIni(
  modelPath: string,
  mmprojPath: string | undefined,
  args: Record<string, string>,
  globals: Record<string, string> = {},
): string {
  const lines: string[] = [];
  if (Object.keys(globals).length) {
    lines.push('[*]', ...Object.entries(globals).map(([key, value]) => `${key} = ${value}`), '');
  }
  lines.push(`[${AGENT_MODEL_ID}]`, `model = ${modelPath}`);
  if (mmprojPath) lines.push(`mmproj = ${mmprojPath}`);
  for (const [key, value] of Object.entries(args)) lines.push(`${key} = ${value}`);
  return `${lines.join('\n')}\n`;
}

/** Where the preset and the saved slots live. */
function agentFiles(paths: ProPaths, config: ProConfig) {
  return {
    presetFile: join(paths.dataDir, 'llm-presets.ini'),
    slotDir: join(paths.dataDir, 'llm-slots'),
    // Per model, so a changed LLM_AGENT_MODEL never restores another model's cache.
    slotFile: `${basename(config.agentModel, '.gguf').replace(/[^\w.-]+/g, '_')}.bin`,
  };
}

/**
 * llama.cpp's locked arguments for the agent, read at each start: one model
 * at a time where the GPU is shared with renders, and the preset and slot
 * folder when an agent model is set. Writes the preset file as a side
 * effect, so a changed setting applies on the next start.
 */
export function agentLlamaArgs(config: ProConfig, paths: ProPaths, settings: SettingsStore): Record<string, string | number | null> {
  const values: Record<string, string | number | null> = { models_max: config.tier !== '96gb' ? 1 : null };
  if (!config.agentModel) return values;
  const { presetFile, slotDir } = agentFiles(paths, config);
  const args = { ...parseLongFlags(AGENT_DEFAULT_ARGS), ...parseLongFlags(config.agentArgs) };
  const { model, mmproj } = resolveAgentModel(paths.llmDir, config.agentModel);
  mkdirSync(slotDir, { recursive: true });
  // The router hands its own flags to every model over the preset's values,
  // so the context size the settings give the other models moves into the
  // preset's global section, where the agent's own can beat it.
  const context = readOverrides(settings, 'llamacpp').values.ctx_size ?? 4096;
  writeFileSync(presetFile, presetIni(model, mmproj, args, { 'ctx-size': String(context) }));
  return { ...values, ctx_size: null, models_preset: presetFile, slot_save_path: slotDir };
}

export interface AgentLlmDeps {
  config: ProConfig;
  paths: ProPaths;
  backends: BackendManager;
  log: FastifyBaseLogger;
}

export class AgentLlm {
  private readonly slotDir: string;
  private readonly slotFile: string;

  constructor(private readonly deps: AgentLlmDeps) {
    ({ slotDir: this.slotDir, slotFile: this.slotFile } = agentFiles(deps.paths, deps.config));
  }

  get enabled(): boolean {
    return Boolean(this.deps.config.agentModel);
  }

  /** Save the agent's slot if it is loaded. Run before llama.cpp stops. */
  async save(): Promise<void> {
    if (!this.enabled || (await this.modelStatus()) !== 'loaded') return;
    const result = await this.post(`/slots/0?action=save`, { model: AGENT_MODEL_ID, filename: this.slotFile });
    this.deps.log.info({ result }, 'saved the agent model slot');
  }

  /**
   * Before a request: if the agent is not loaded and a saved slot exists,
   * load it and restore the slot, so the request's prefix is already
   * processed. Best effort: without it the request just prefills.
   */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.enabled || !existsSync(join(this.slotDir, this.slotFile))) return;
    if ((await this.modelStatus()) === 'loaded') return;
    try {
      await this.post('/models/load', { model: AGENT_MODEL_ID });
      const deadline = Date.now() + 300_000;
      while ((await this.modelStatus()) !== 'loaded') {
        if (signal?.aborted || Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const result = await this.post(`/slots/0?action=restore`, { model: AGENT_MODEL_ID, filename: this.slotFile });
      this.deps.log.info({ result }, 'restored the agent model slot');
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'could not restore the agent model slot');
    }
  }

  private async modelStatus(): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.deps.backends.baseUrl('llamacpp')}/models`, { signal: AbortSignal.timeout(5000) });
      const body = (await response.json()) as { data?: { id: string; status?: { value?: string } }[] };
      return body.data?.find((m) => m.id === AGENT_MODEL_ID)?.status?.value;
    } catch {
      return undefined;
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.deps.backends.baseUrl('llamacpp')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`llama.cpp ${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}
