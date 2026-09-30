import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.js';
import { settings } from './schema.js';

/**
 * Typed, persisted key/value settings.
 *
 * The distinction from `Config`: env vars are the *deployment* contract — set
 * once by whoever runs the container, read-only at runtime. These are the
 * *user's* preferences, edited from the Preferences screen and persisted to
 * the volume so they survive a restart. Requirement 5's "never hardcode CLI
 * args" is what makes this necessary: the args a backend spawns with have to
 * be editable without a redeploy, which means they cannot live in env vars or
 * in the source.
 *
 * Each key declares a zod schema and a default. Reads validate, and fall back
 * to the default if a stored value no longer parses (a shape changed between
 * releases), so a stale row can never stop the app from booting.
 */
export class SettingsStore {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly db: Db) {}

  get<T>(key: SettingKey<T>): T {
    const cached = this.cache.get(key.name);
    if (cached !== undefined) return cached as T;

    const row = this.db.select().from(settings).where(eq(settings.key, key.name)).get();
    if (!row) {
      this.cache.set(key.name, key.defaultValue);
      return key.defaultValue;
    }
    const parsed = key.schema.safeParse(row.value);
    const value = parsed.success ? parsed.data : key.defaultValue;
    this.cache.set(key.name, value);
    return value;
  }

  set<T>(key: SettingKey<T>, value: T): T {
    const parsed = key.schema.parse(value);
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ key: key.name, value: parsed as unknown, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: parsed as unknown, updatedAt: now },
      })
      .run();
    this.cache.set(key.name, parsed);
    return parsed;
  }

  /** Merge a partial object into an object-valued setting. */
  patch<T extends Record<string, unknown>>(key: SettingKey<T>, partial: Partial<T>): T {
    return this.set(key, { ...this.get(key), ...partial });
  }

  /** Drop a stored value, reverting the key to its default. */
  reset<T>(key: SettingKey<T>): T {
    this.db.delete(settings).where(eq(settings.key, key.name)).run();
    this.cache.delete(key.name);
    return key.defaultValue;
  }
}

export interface SettingKey<T> {
  name: string;
  /**
   * Input is `unknown` rather than `T`: values arrive from a JSON column and
   * from request bodies, and schemas with `.default()` legitimately accept a
   * narrower input than they produce.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  defaultValue: T;
}

export function defineSetting<T>(
  name: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  defaultValue: T,
): SettingKey<T> {
  return { name, schema, defaultValue };
}
