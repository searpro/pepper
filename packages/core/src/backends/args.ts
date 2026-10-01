import { z } from 'zod';
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
  backend: string;
  label: string;
  /** Whether the backend is a persistent server or spawned per request. */
  kind: 'server' | 'cli';
  args: ArgDefinition[];
}

/** A user's overrides for one backend: `{ [key]: value }` plus free-form extras. */
export const backendOverridesSchema = z.object({
  values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Appended verbatim, for flags the spec does not model. */
  extraArgs: z.array(z.string()).default([]),
});

export type BackendOverrides = z.infer<typeof backendOverridesSchema>;

const EMPTY_OVERRIDES: BackendOverrides = { values: {}, extraArgs: [] };

export function overridesKey(backend: string) {
  return defineSetting<BackendOverrides>(
    `backend.${backend}.args`,
    backendOverridesSchema,
    EMPTY_OVERRIDES,
  );
}

export function readOverrides(settings: SettingsStore, backend: string): BackendOverrides {
  return settings.get(overridesKey(backend));
}

export function writeOverrides(
  settings: SettingsStore,
  backend: string,
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
