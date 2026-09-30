import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Projects (docs/PEPPER-PRO.md §8): the domain Pepper Pro is organised
 * around. A project holds a script and a style, a library of assets, scenes
 * of shots, the takes each shot was rendered as, and cuts assembled from
 * chosen takes.
 *
 * A take *is* a job: its status, progress and logs are the job's. The take
 * row adds only what the job does not know — which shot it belongs to,
 * whether it was chosen, and where its file was kept (takes are copied out of
 * the swept outputs directory into the project, so a cut made next week
 * still has its footage).
 */

export const ASPECTS = ['9:16', '16:9', '1:1', '4:5', '4:3', '3:4', '21:9'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const ASSET_KINDS = ['character', 'location', 'prop', 'product', 'voice', 'audio', 'style'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const SHOT_KINDS = ['dialogue', 'action', 'talking', 'performance', 'broll', 'product', 'establishing'] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    aspect: text('aspect').notNull().default('9:16'),
    fps: integer('fps').notNull().default(24),
    /** A style line added to every shot's prompt ("warm film look, shallow depth of field"). */
    style: text('style').notNull().default(''),
    /** Upload name of a `.cube` LUT applied to the whole cut. */
    lut: text('lut'),
    licenceMode: text('licence_mode').notNull().default('personal'),
    script: text('script').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ updatedIdx: index('projects_updated_idx').on(t.updatedAt) }),
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    /** Null for a library asset shared by every project. */
    projectId: text('project_id'),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** Drawable description reused in every prompt the asset appears in. */
    description: text('description').notNull().default(''),
    /** Upload names: reference images, a character sheet, a packshot. */
    images: text('images', { mode: 'json' }).notNull().default([]),
    /** A voice: `{ upload?, description? }` — a timbre reference clip and how it should sound. */
    voice: text('voice', { mode: 'json' }),
    /** An audio asset's upload name (a song, a voice line). */
    audio: text('audio'),
    meta: text('meta', { mode: 'json' }).notNull().default({}),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ projectIdx: index('assets_project_idx').on(t.projectId) }),
);

export const scenes = sqliteTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ projectIdx: index('scenes_project_idx').on(t.projectId, t.position) }),
);

export const shots = sqliteTable(
  'shots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    sceneId: text('scene_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').notNull().default('action'),
    durationS: real('duration_s').notNull().default(5),
    framing: text('framing').notNull().default(''),
    camera: text('camera').notNull().default(''),
    /** What happens in the shot, in the director's words. */
    prompt: text('prompt').notNull().default(''),
    /** `{ asset_id, line }[]`: who says what, in order. */
    dialogue: text('dialogue', { mode: 'json' }).notNull().default([]),
    /** Sound direction: ambience, effects, music ("rain on glass, distant traffic"). */
    sound: text('sound').notNull().default(''),
    /** Assets in the shot, in the order their images become references. */
    assetIds: text('asset_ids', { mode: 'json' }).notNull().default([]),
    /** `{ first?, last? }`: upload names of keyframes. */
    keyframes: text('keyframes', { mode: 'json' }).notNull().default({}),
    /** Audio asset that drives the shot (lip-sync, a song); null lets the model voice it. */
    audioAssetId: text('audio_asset_id'),
    recipeId: text('recipe_id'),
    /** Recipe parameters that override what the shot derives. */
    params: text('params', { mode: 'json' }).notNull().default({}),
    chosenTakeId: text('chosen_take_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    sceneIdx: index('shots_scene_idx').on(t.sceneId, t.position),
    projectIdx: index('shots_project_idx').on(t.projectId),
  }),
);

export const takes = sqliteTable(
  'takes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    shotId: text('shot_id').notNull(),
    jobId: text('job_id').notNull(),
    /** Recipe mode: `draft` takes find the shot, `final` ones finish it. */
    mode: text('mode').notNull(),
    seed: integer('seed'),
    /** Copy of the output kept in the project, once the job completes. */
    file: text('file'),
    score: integer('score'),
    notes: text('notes').notNull().default(''),
    /** A vision model's check of the take: `{ ok, score, issues[], model, at }`. */
    review: text('review', { mode: 'json' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    shotIdx: index('takes_shot_idx').on(t.shotId, t.createdAt),
    jobIdx: index('takes_job_idx').on(t.jobId),
  }),
);

export const cuts = sqliteTable(
  'cuts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull().default('Main cut'),
    /** `{ take_id, in?, out?, transition? }[]` — in and out in seconds within the take. */
    items: text('items', { mode: 'json' }).notNull().default([]),
    /** `{ asset_id, gain_db?, duck? }`: a music bed under the whole cut. */
    music: text('music', { mode: 'json' }),
    /** Burn the dialogue in as subtitles. */
    subtitles: integer('subtitles', { mode: 'boolean' }).notNull().default(false),
    /** Move each cut point back to the music bed's nearest beat. */
    beatSync: integer('beat_sync', { mode: 'boolean' }).notNull().default(false),
    exportJobId: text('export_job_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ projectIdx: index('cuts_project_idx').on(t.projectId) }),
);

export type ProjectRow = typeof projects.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type ShotRow = typeof shots.$inferSelect;
export type TakeRow = typeof takes.$inferSelect;
export type CutRow = typeof cuts.$inferSelect;

/** Created on boot beside the shared tables (see `@pepper/core/db/client.ts`). */
export const PRO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aspect TEXT NOT NULL DEFAULT '9:16',
  fps INTEGER NOT NULL DEFAULT 24,
  style TEXT NOT NULL DEFAULT '',
  lut TEXT,
  licence_mode TEXT NOT NULL DEFAULT 'personal',
  script TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_updated_idx ON projects (updated_at);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  voice TEXT,
  audio TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_project_idx ON assets (project_id);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scenes_project_idx ON scenes (project_id, position);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'action',
  duration_s REAL NOT NULL DEFAULT 5,
  framing TEXT NOT NULL DEFAULT '',
  camera TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  dialogue TEXT NOT NULL DEFAULT '[]',
  sound TEXT NOT NULL DEFAULT '',
  asset_ids TEXT NOT NULL DEFAULT '[]',
  keyframes TEXT NOT NULL DEFAULT '{}',
  audio_asset_id TEXT,
  recipe_id TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  chosen_take_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shots_scene_idx ON shots (scene_id, position);
CREATE INDEX IF NOT EXISTS shots_project_idx ON shots (project_id);

CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  seed INTEGER,
  file TEXT,
  score INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS takes_shot_idx ON takes (shot_id, created_at);
CREATE INDEX IF NOT EXISTS takes_job_idx ON takes (job_id);

CREATE TABLE IF NOT EXISTS cuts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Main cut',
  items TEXT NOT NULL DEFAULT '[]',
  music TEXT,
  subtitles INTEGER NOT NULL DEFAULT 0,
  export_job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cuts_project_idx ON cuts (project_id);
`;

/** Ordered upgrades to Pepper Pro's own tables. */
export const PRO_MIGRATIONS: string[] = [
  'ALTER TABLE takes ADD COLUMN review TEXT',
  'ALTER TABLE cuts ADD COLUMN beat_sync INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE golden_results ADD COLUMN review TEXT',
];
