import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema (requirement 11's "SQLite + drizzle, db in DATA_DIR").
 *
 * sd-api kept jobs, downloads and settings purely in memory, so a restart —
 * including the automatic one the process manager now performs when a backend
 * is swapping — erased every queued job and every in-flight download record.
 * Anything a user can abort, retry or delete has to outlive the process, so
 * those three live here. Deliberately *not* here: the model list (requirement
 * 8 makes the filesystem the source of truth, and a database that disagrees
 * with the disk is worse than no database) and log records (a bounded ring
 * buffer, not history).
 *
 * Timestamps are stored as epoch milliseconds — integers sort and compare
 * correctly in SQLite, unlike ISO strings across timezones — and converted to
 * ISO strings at the API boundary, which is what sd-api's wire format used.
 */

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Which generation surface produced this job: image | video | audio | text. */
    kind: text('kind').notNull(),
    /** queued | running | completed | failed | cancelled */
    status: text('status').notNull(),
    /** 0..1 */
    progress: integer('progress', { mode: 'number' }).notNull().default(0),
    step: integer('step'),
    totalSteps: integer('total_steps'),
    /** The validated request body, verbatim — what a retry re-submits. */
    params: text('params', { mode: 'json' }).notNull(),
    result: text('result', { mode: 'json' }),
    error: text('error', { mode: 'json' }),
    /** Incremented on each retry, so a client can tell a retry from the original run. */
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (table) => ({
    statusIdx: index('jobs_status_idx').on(table.status),
    createdIdx: index('jobs_created_idx').on(table.createdAt),
  }),
);

export const downloads = sqliteTable(
  'downloads',
  {
    id: text('id').primaryKey(),
    /** Model kind — the `models/<kind>/` directory this download lands in. */
    kind: text('kind').notNull(),
    /** Bundle directory name under `models/<kind>/`. */
    bundle: text('bundle').notNull(),
    /**
     * Component slot within the bundle: checkpoint | vae | clip | lora |
     * weights | aux, or `other:<dirname>` for requirement 8's "other
     * (specify)" case.
     */
    component: text('component').notNull(),
    /** Final filename on disk. */
    name: text('name').notNull(),
    url: text('url').notNull(),
    /** queued | downloading | completed | failed | cancelled */
    status: text('status').notNull(),
    received: integer('received').notNull().default(0),
    total: integer('total'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    statusIdx: index('downloads_status_idx').on(table.status),
    bundleIdx: index('downloads_bundle_idx').on(table.kind, table.bundle),
  }),
);

/**
 * Runtime-mutable preferences: backend CLI args, generation defaults, UI
 * settings. Env vars stay the deployment contract; this is what the
 * Preferences screen writes, so a user can retune a backend without a
 * redeploy. One row per key, value is JSON.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type DownloadRow = typeof downloads.$inferSelect;
export type NewDownloadRow = typeof downloads.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
