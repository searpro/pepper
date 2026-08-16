import { z } from 'zod';
import type { BackendId } from '../config.js';
import { defineSetting, type SettingsStore } from '../db/settings.js';

/**
 * Customisable backend CLI arguments (requirement 5).
 *
 * "Never hardcode CLI args. The current working args can be seeded initially
 * so the backends will work exactly like sd-api."
 *
 * So each backend declares its arguments as data: a stable key, the flag it
 * renders to, a type, and the value sd-api used. The declaration is what the
 * Preferences screen renders a form from — no per-backend UI code — and what
 * `renderArgs()` turns into argv. A user's overrides live in SQLite, so
 * retuning `-c` or `-ngl` is a settings write, not a redeploy.
 *
 * Two escape hatches keep this from becoming a cage: `extraArgs` appends
 * anything the schema does not model (new upstream flags land constantly), and
 * a `null` override drops an argument entirely.
 *
 * **Locked arguments.** `--host`/`--port`/`--models-dir` and friends are
 * marked `locked` and computed at spawn time. They are not a style choice:
 * these processes have no authentication of their own, so binding one to
 * anything but loopback would publish an unauthenticated inference server, and
 * a wrong `--models-dir` silently serves nothing. They are still *shown* in
 * the UI (so the effective command line is never a mystery), just not editable.
 */

export type ArgType = 'string' | 'number' | 'boolean' | 'enum';

export interface ArgDefinition {
  /** Stable identifier used as the settings key. Never rendered to argv. */
  key: string;
  /** The CLI flag this renders to, e.g. `-c` or `--jinja`. */
  flag: string;
  label: string;
  description?: string;
  type: ArgType;
  /** Allowed values, for `type: 'enum'`. */
  options?: string[];
  /** sd-api's working value, used when the user has not overridden it. */
  defaultValue?: string | number | boolean | null;
  /** Computed at spawn time and not user-editable — see the note above. */
  locked?: boolean;
  /** Minimum/maximum for numeric inputs, so the UI can validate. */
  min?: number;
  max?: number;
}

export interface BackendArgSpec {
  backend: BackendId;
  label: string;
  /** Whether the backend is a persistent server or spawned per request. */
  kind: 'server' | 'cli';
  args: ArgDefinition[];
}

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

/**
 * audio.cpp. Unlike llama.cpp it has no directory-scan mode: it loads an
 * explicit JSON model registry via `--config`, which the app generates (see
 * `src/backends/audio-config.ts`).
 */
export const AUDIOCPP_ARGS: BackendArgSpec = {
  backend: 'audiocpp',
  label: 'audio.cpp (speech & transcription)',
  kind: 'server',
  args: [
    {
      key: 'config',
      flag: '--config',
      label: 'Model registry',
      description: 'Generated from the installed audio bundles. Managed by the app.',
      type: 'string',
      locked: true,
    },
    {
      key: 'host',
      flag: '--host',
      label: 'Bind address',
      type: 'string',
      defaultValue: '127.0.0.1',
      locked: true,
    },
    { key: 'port', flag: '--port', label: 'Port', type: 'number', locked: true },
    {
      // audiocpp_server defaults `--backend` to cuda, so every non-CUDA host
      // fails at startup ("CUDA backend requested but it is not registered in
      // this build") even when the correct Metal/Vulkan asset was installed.
      // The value is derived from ACCEL rather than left to the binary.
      key: 'backend',
      flag: '--backend',
      label: 'Compute backend',
      description: 'Derived from ACCEL. Must match the installed build.',
      type: 'string',
      locked: true,
    },
    {
      key: 'threads',
      flag: '-t',
      label: 'Threads',
      description: 'CPU threads for inference. Empty uses the backend default.',
      type: 'number',
      defaultValue: null,
      min: 1,
      max: 256,
    },
  ],
};

/**
 * stable-diffusion.cpp. Spawned fresh per generation, so most of its argv is
 * per-request (prompt, model, size) and built by the image service. Only the
 * process-wide options that apply to *every* run are configurable here.
 */
export const SDCPP_ARGS: BackendArgSpec = {
  backend: 'sdcpp',
  label: 'stable-diffusion.cpp (image & video)',
  kind: 'cli',
  args: [
    {
      key: 'threads',
      flag: '-t',
      label: 'Threads',
      description: 'CPU threads. Empty lets sd-cli choose based on the host.',
      type: 'number',
      defaultValue: null,
      min: 1,
      max: 256,
    },
    {
      key: 'diffusion_fa',
      flag: '--diffusion-fa',
      label: 'Flash attention (diffusion)',
      description: 'Lower memory use on supported GPUs.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'vae_tiling',
      flag: '--vae-tiling',
      label: 'VAE tiling',
      description: 'Decode large images in tiles. Slower, but avoids VAE out-of-memory.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'offload_to_cpu',
      flag: '--offload-to-cpu',
      label: 'Offload to CPU',
      description: 'Keep idle weights in system RAM. Helps on tight VRAM.',
      type: 'boolean',
      defaultValue: false,
    },
    {
      key: 'verbose',
      flag: '-v',
      label: 'Verbose output',
      description: 'More detailed logs from the generator, streamed to the Log viewer.',
      type: 'boolean',
      defaultValue: false,
    },
  ],
};

/**
 * Experimental Python backend (requirement 5's forward-looking item). Nothing
 * generates against it yet; the argument surface exists so the install and
 * supervision paths are exercised by the same code as the others.
 */
export const PYTHON_ARGS: BackendArgSpec = {
  backend: 'python',
  label: 'Python backend (experimental)',
  kind: 'server',
  args: [
    {
      key: 'listen',
      flag: '--listen',
      label: 'Bind address',
      type: 'string',
      defaultValue: '127.0.0.1',
      locked: true,
    },
    { key: 'port', flag: '--port', label: 'Port', type: 'number', locked: true },
    {
      key: 'cpu',
      flag: '--cpu',
      label: 'Force CPU',
      description: 'Run without CUDA even when a GPU is present.',
      type: 'boolean',
      defaultValue: false,
    },
  ],
};

export const ARG_SPECS: Record<BackendId, BackendArgSpec> = {
  sdcpp: SDCPP_ARGS,
  llamacpp: LLAMACPP_ARGS,
  audiocpp: AUDIOCPP_ARGS,
  python: PYTHON_ARGS,
};

/** A user's overrides for one backend: `{ [key]: value }` plus free-form extras. */
export const backendOverridesSchema = z.object({
  values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Appended verbatim, for flags the spec does not model. */
  extraArgs: z.array(z.string()).default([]),
});

export type BackendOverrides = z.infer<typeof backendOverridesSchema>;

const EMPTY_OVERRIDES: BackendOverrides = { values: {}, extraArgs: [] };

export function overridesKey(backend: BackendId) {
  return defineSetting<BackendOverrides>(
    `backend.${backend}.args`,
    backendOverridesSchema,
    EMPTY_OVERRIDES,
  );
}

export function readOverrides(settings: SettingsStore, backend: BackendId): BackendOverrides {
  return settings.get(overridesKey(backend));
}

export function writeOverrides(
  settings: SettingsStore,
  backend: BackendId,
  overrides: BackendOverrides,
): BackendOverrides {
  return settings.set(overridesKey(backend), overrides);
}

/** The value a given argument will actually be spawned with. */
export interface EffectiveArg extends ArgDefinition {
  value: string | number | boolean | null;
  /** True when the value came from a user override rather than the default. */
  overridden: boolean;
}

/**
 * Resolve a backend's arguments: locked values from `managed`, everything else
 * from the user's overrides falling back to the seeded default.
 */
export function effectiveArgs(
  spec: BackendArgSpec,
  overrides: BackendOverrides,
  managed: Record<string, string | number | boolean | null> = {},
): EffectiveArg[] {
  return spec.args.map((definition) => {
    if (definition.locked) {
      return {
        ...definition,
        value: managed[definition.key] ?? definition.defaultValue ?? null,
        overridden: false,
      };
    }
    const has = Object.prototype.hasOwnProperty.call(overrides.values, definition.key);
    return {
      ...definition,
      value: has ? overrides.values[definition.key] : (definition.defaultValue ?? null),
      overridden: has,
    };
  });
}

/**
 * Render resolved arguments to argv.
 *
 * `null` and `undefined` drop the argument entirely — that is how "let the
 * backend decide" is expressed (sd-api used a `-1` sentinel for `-ngl`, which
 * only worked because that one flag happened to have an impossible value to
 * spare). `false` on a boolean drops it too, since these are all presence
 * flags with no `--no-x` counterpart.
 */
export function renderArgs(args: EffectiveArg[], extraArgs: string[] = []): string[] {
  const argv: string[] = [];
  for (const arg of args) {
    if (arg.value === null || arg.value === undefined || arg.value === '') continue;
    if (arg.type === 'boolean') {
      if (arg.value === true) argv.push(arg.flag);
      continue;
    }
    argv.push(arg.flag, String(arg.value));
  }
  argv.push(...extraArgs);
  return argv;
}

/** Convenience: spec + overrides + managed values → argv. */
export function buildArgv(
  spec: BackendArgSpec,
  overrides: BackendOverrides,
  managed: Record<string, string | number | boolean | null> = {},
): string[] {
  return renderArgs(effectiveArgs(spec, overrides, managed), overrides.extraArgs);
}
