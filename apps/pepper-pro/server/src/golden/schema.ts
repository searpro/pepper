import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Golden-shot runs (docs/PEPPER-PRO.md §9.4). A run renders a recipe
 * version's applicable golden shots with fixed seeds; each result keeps its
 * file under DATA_DIR/golden/<recipe>/v<version>/<mode>/ so later versions are
 * compared against it. Votes are the blind A/B verdicts between versions.
 */

export const goldenRuns = sqliteTable('golden_runs', {
  id: text('id').primaryKey(),
  recipeId: text('recipe_id').notNull(),
  recipeVersion: integer('recipe_version').notNull(),
  mode: text('mode').notNull(),
  /** preparing (making inputs) → rendering → done, or failed. */
  status: text('status').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
});

export const goldenResults = sqliteTable(
  'golden_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    shotId: text('shot_id').notNull(),
    jobId: text('job_id'),
    /** queued, running, completed, failed, or skipped (with why in `error`). */
    status: text('status').notNull(),
    /** Relative to DATA_DIR/golden. */
    file: text('file'),
    error: text('error'),
  },
  (t) => ({ runIdx: index('golden_results_run_idx').on(t.runId), jobIdx: index('golden_results_job_idx').on(t.jobId) }),
);

export const goldenVotes = sqliteTable('golden_votes', {
  id: text('id').primaryKey(),
  recipeId: text('recipe_id').notNull(),
  shotId: text('shot_id').notNull(),
  mode: text('mode').notNull(),
  versionA: integer('version_a').notNull(),
  versionB: integer('version_b').notNull(),
  /** The winning version, or null for a tie. */
  winner: integer('winner'),
  createdAt: integer('created_at').notNull(),
});

export type GoldenRunRow = typeof goldenRuns.$inferSelect;
export type GoldenResultRow = typeof goldenResults.$inferSelect;
export type GoldenVoteRow = typeof goldenVotes.$inferSelect;

export const GOLDEN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS golden_runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS golden_runs_recipe_idx ON golden_runs (recipe_id, created_at);

CREATE TABLE IF NOT EXISTS golden_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  file TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS golden_results_run_idx ON golden_results (run_id);
CREATE INDEX IF NOT EXISTS golden_results_job_idx ON golden_results (job_id);

CREATE TABLE IF NOT EXISTS golden_votes (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  version_a INTEGER NOT NULL,
  version_b INTEGER NOT NULL,
  winner INTEGER,
  created_at INTEGER NOT NULL
);
`;
