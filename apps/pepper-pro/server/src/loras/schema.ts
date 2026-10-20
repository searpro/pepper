import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The LoRA library: LoRAs downloaded from HuggingFace, Civitai or any link,
 * each usable with every recipe on its base model (`bases.ts`). A row holds
 * what the file cannot say about itself — its name, base, trigger words,
 * where it came from — while whether it is on disk is read from disk, per
 * "anything describing files on disk is read from disk".
 *
 * Files live in `models/loras/library/`, apart from the LoRAs recipes ship
 * with, so deleting one from the library can never take a recipe's file.
 */
export const loras = sqliteTable('loras', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** A `LORA_BASES` id: the recipes it fits. */
  base: text('base').notNull(),
  /** File name in `models/loras/library/`. */
  file: text('file').notNull(),
  /** What the file downloads from. */
  url: text('url').notNull(),
  /** `huggingface`, `civitai` or `url`. */
  source: text('source').notNull(),
  /** The model's page, for a person to read. */
  pageUrl: text('page_url'),
  /** The base model as the source names it ("Qwen-Image 2.1", "Flux.2 Klein 4B"). */
  sourceBase: text('source_base'),
  /** Words the LoRA was trained to respond to; the prompt must contain them. */
  triggerWords: text('trigger_words', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** The weight it is applied at unless a request says otherwise. */
  strength: real('strength').notNull().default(1),
  description: text('description').notNull().default(''),
  previewUrl: text('preview_url'),
  bytes: integer('bytes'),
  sha256: text('sha256'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type LoraRow = typeof loras.$inferSelect;

export const LORA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS loras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base TEXT NOT NULL,
  file TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  page_url TEXT,
  source_base TEXT,
  trigger_words TEXT NOT NULL DEFAULT '[]',
  strength REAL NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  preview_url TEXT,
  bytes INTEGER,
  sha256 TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
