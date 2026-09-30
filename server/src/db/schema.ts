import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Pepper's own tables, beside the shared jobs, downloads and settings
 * (`core/db/schema.ts`).
 */

export * from '../core/db/schema.js';

/**
 * Character Studio: a reusable cast. Images are *upload* names — a character's
 * sheet and portraits have to outlive the output retention sweep, and uploads
 * are what `init_image` / `ref_images` take — so a character can be dropped
 * into any generation without copying anything first.
 */
export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** What the user typed: the minimal prompt the sheet was expanded from. */
    brief: text('brief').notNull().default(''),
    /** Art style, e.g. "photorealistic", "anime cel-shaded". */
    style: text('style').notNull().default(''),
    /** Visual description, reused verbatim in every prompt the character appears in. */
    appearance: text('appearance').notNull().default(''),
    personality: text('personality').notNull().default(''),
    /** `CharacterImage[]` */
    images: text('images', { mode: 'json' }).notNull().default([]),
    /** Upload name of the image the picker shows. */
    thumbnail: text('thumbnail'),
    /** `CharacterVoice | null` */
    voice: text('voice', { mode: 'json' }),
    /** Jobs generating something for this character: `{ jobId, role }[]` */
    pending: text('pending', { mode: 'json' }).notNull().default([]),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    updatedIdx: index('characters_updated_idx').on(table.updatedAt),
  }),
);

export type CharacterRow = typeof characters.$inferSelect;

/** Created on boot beside the shared tables. */
export const PEPPER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  thumbnail TEXT,
  voice TEXT,
  pending TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_updated_idx ON characters (updated_at);
`;

/** Ordered upgrades to Pepper's own tables; see `openDb`. */
export const PEPPER_MIGRATIONS: string[] = [];
