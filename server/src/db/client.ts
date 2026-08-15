import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Schema creation is done here in plain SQL rather than through generated
 * drizzle-kit migration files. The schema is created by the app on first boot
 * against a database file inside a volume it may be seeing for the first time,
 * so shipping a migrations directory that has to be present and readable at
 * runtime adds a failure mode without adding anything: there is exactly one
 * writer, and `IF NOT EXISTS` is idempotent. Drizzle still owns every *query*
 * — this is only the bootstrap.
 *
 * When a column is added later, add an `ALTER TABLE` to `MIGRATIONS` below;
 * `user_version` tracks which have run.
 */
const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  step INTEGER,
  total_steps INTEGER,
  params TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bundle TEXT NOT NULL,
  component TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS downloads_status_idx ON downloads (status);
CREATE INDEX IF NOT EXISTS downloads_bundle_idx ON downloads (kind, bundle);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** Ordered schema upgrades. Index + 1 is the resulting `user_version`. */
const MIGRATIONS: string[] = [];

export interface OpenDbResult {
  db: Db;
  /** The underlying handle, for `close()` on shutdown. */
  sqlite: Database.Database;
}

export function openDb(file: string): OpenDbResult {
  const sqlite = new Database(file);

  // WAL lets the SSE/streaming readers run while a job writer commits; without
  // it, SQLite's default rollback journal takes a whole-database write lock and
  // a progress update can block a list query mid-stream.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // A download settling and a job finishing can land at the same instant; five
  // seconds of retry is far cheaper than surfacing SQLITE_BUSY to a client.
  sqlite.pragma('busy_timeout = 5000');

  sqlite.exec(CREATE_SQL);
  applyMigrations(sqlite);

  return { db: drizzle(sqlite, { schema }), sqlite };
}

function applyMigrations(sqlite: Database.Database): void {
  const current = (sqlite.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    sqlite.exec(MIGRATIONS[version]);
    sqlite.pragma(`user_version = ${version + 1}`);
  }
}
