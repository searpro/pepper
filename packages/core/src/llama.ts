import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BackendArgSpec } from './backends/args.js';
import { BinaryInstaller } from './backends/installer.js';
import type { BackendDefinition } from './backends/manager.js';
import type { Accel } from './config.js';

/**
 * llama.cpp, which every product runs for text (chat, prompt writing,
 * captions): its argument table and its backend definition.
 */

/**
 * llama.cpp, in router mode: no `-m`, models are discovered from
 * `--models-dir` and requests route by the `"model"` field in the body.
 * Values mirror sd-api's `config/default.json` exactly.
 */
export const LLAMACPP_ARGS: BackendArgSpec = {
  backend: 'llamacpp',
  label: 'llama.cpp (text generation)',
  kind: 'server',
  args: [
    {
      key: 'models_dir',
      flag: '--models-dir',
      label: 'Models directory',
      description: 'Scanned at startup for GGUF models. Managed by the app.',
      type: 'string',
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
      key: 'ctx_size',
      flag: '-c',
      label: 'Context size',
      description: 'Tokens of context per model. Higher costs proportionally more memory.',
      type: 'number',
      defaultValue: 4096,
      min: 256,
      max: 1_048_576,
    },
    {
      key: 'gpu_layers',
      flag: '-ngl',
      label: 'GPU layers',
      description: 'Layers offloaded to the GPU. Leave empty to let llama.cpp decide.',
      type: 'number',
      defaultValue: null,
      min: 0,
      max: 999,
    },
    {
      key: 'jinja',
      flag: '--jinja',
      label: 'Jinja chat templates',
      description: 'Required for tool-calling and most instruct templates.',
      type: 'boolean',
      defaultValue: true,
    },
    {
      key: 'flash_attn',
      flag: '--flash-attn',
      label: 'Flash attention',
      description: 'Faster attention on supported GPUs.',
      type: 'boolean',
      defaultValue: false,
    },
  ],
};


export interface LlamacppOptions {
  port: number;
  /** "owner/repo" whose latest release is installed. */
  releaseRepo: string;
  /** Where the release is installed: `DATA_DIR/bin/llamacpp`. */
  installDir: string;
  accel: Accel;
  /** The directory llama.cpp's router scans for GGUF models. */
  modelsDir: () => string;
  log: FastifyBaseLogger;
}

export function llamacppDefinition(options: LlamacppOptions): BackendDefinition {
  return {
    id: 'llamacpp',
    argSpec: LLAMACPP_ARGS,
    command: 'llama-server',
    releaseRepo: options.releaseRepo,
    installer: new BinaryInstaller(
      { backend: 'llamacpp', repo: options.releaseRepo, installDir: options.installDir, accel: options.accel },
      options.log,
    ),
    server: { port: options.port, healthPath: '/health' },
    managed: () => ({ models_dir: options.modelsDir(), host: '127.0.0.1', port: options.port }),
  };
}

/** The default models directory under `DATA_DIR/models`. */
export function llmModelsDir(modelsDir: string): string {
  return join(modelsDir, 'llm');
}
