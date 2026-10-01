import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
/**
 * The database type every shared service takes. Queries go through the table
 * objects (`db.select().from(jobs)`), not drizzle's relational `db.query`, so
 * the schema generic carries nothing and each product's tables fit the same
 * type.
 */
export type Db = BetterSQLite3Database<Record<string, unknown>>;

/** A product's own tables, created beside the shared ones. */
export interface ProductSchema {
  /** Namespace its migrations are counted under, e.g. "pepper". */
  name: string;
  /** `CREATE TABLE IF NOT EXISTS …` statements. */
  sql: string;
  /** Ordered upgrades; each runs once, tracked in `schema_versions`. */
  migrations: string[];
}

/**
 * Schema creation is done here in plain SQL rather than through generated
 * drizzle-kit migration files. The schema is created by the app on first boot
 * against a database file inside a volume it may be seeing for the first time,
 * so shipping a migrations directory that has to be present and readable at
 * runtime adds a failure mode without adding anything: there is exactly one
 * writer, and `IF NOT EXISTS` is idempotent. Drizzle still owns every *query*
 * — this is only the bootstrap.
 *
 * When a column is added later, add an `ALTER TABLE` to the owning list —
 * `CORE_MIGRATIONS` below for the shared tables, the product's own list for
 * its tables. Each list is counted separately in `schema_versions`, so two
 * products never disagree about what a version number means.
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

CREATE TABLE IF NOT EXISTS schema_versions (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);
`;

/** Ordered upgrades to the shared tables. */
const CORE_MIGRATIONS: string[] = [];

export interface OpenDbResult {
  db: Db;
  /** The underlying handle, for `close()` on shutdown. */
  sqlite: Database.Database;
  /**
   * Set when the file could not be written and the database lives in memory
   * for this run instead: why, in SQLite's words.
   */
  temporary?: string;
}

/**
 * Open the database, setting a corrupt one aside first.
 *
 * A full volume can leave SQLite's file malformed (seen on RunPod: a download
 * hit the volume quota mid-write, and every later query failed with "database
 * disk image is malformed"). There is no shell on a pod to repair it with, and
 * nothing in it is irreplaceable — models and outputs are read from disk; the
 * database holds job history, download records and preferences. So a file that
 * fails SQLite's own check is renamed `<file>.corrupt-<time>` and a fresh one
 * is created, which turns an unusable server into one that has forgotten its
 * history.
 *
 * A full volume that leaves the file intact is handled one step further on:
 * if the database cannot be written at all (no space, quota exceeded, a
 * read-only mount), this run keeps its state in memory and says so
 * (`temporary`). The server then starts, which is the only way anyone can
 * delete a model to make room; refusing to boot would leave a pod with no
 * shell restarting forever.
 */
export function openDb(
  file: string,
  onRecovered?: (movedTo: string, reason: string) => void,
  product?: ProductSchema,
): OpenDbResult {
  if (file !== ':memory:') {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const reason = corruption(file);
      if (reason) {
        const movedTo = `${file}.corrupt-${Date.now()}`;
        renameSync(file, movedTo);
        // The write-ahead log and shared-memory files belong to the old database.
        for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
        onRecovered?.(movedTo, reason);
      }
      return prepare(configure(new Database(file)), true, product);
    } catch (err) {
      return { ...prepare(configure(new Database(':memory:')), false, product), temporary: (err as Error).message };
    }
  }
  return prepare(configure(new Database(file)), false, product);
}

/**
 * Connection settings. Exclusive locking comes first, and matters: in WAL
 * mode SQLite otherwise coordinates through a memory-mapped `-shm` file, and
 * a mapped page the filesystem cannot back kills the process with SIGBUS — no
 * exception, no log line. That is what a RunPod volume at its quota did, on
 * every boot. With the lock held exclusively the index lives on the heap, no
 * `-shm` file exists, and a full disk is an error SQLite reports. Nothing is
 * lost by it: this process is the database's only user. (It is also the one
 * configuration in which SQLite supports WAL on a network filesystem.)
 */
function configure(sqlite: Database.Database): Database.Database {
  sqlite.pragma('locking_mode = EXCLUSIVE');
  // WAL lets the SSE/streaming readers run while a job writer commits; without
  // it, SQLite's default rollback journal takes a whole-database write lock and
  // a progress update can block a list query mid-stream.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // A download settling and a job finishing can land at the same instant; five
  // seconds of retry is far cheaper than surfacing SQLITE_BUSY to a client.
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

function prepare(sqlite: Database.Database, proveWritable: boolean, product?: ProductSchema): OpenDbResult {
  try {
    sqlite.exec(CREATE_SQL);
    applyMigrations(sqlite, 'core', CORE_MIGRATIONS);
    if (product) {
      sqlite.exec(product.sql);
      applyMigrations(sqlite, product.name, product.migrations);
    }
    // Creating tables that already exist writes nothing, so write something:
    // better to learn now that the disk is full than on the first job.
    if (proveWritable) {
      sqlite
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('db.opened_at', @now, @now)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run({ now: Date.now() });
    }
  } catch (err) {
    sqlite.close();
    throw err;
  }
  return { db: drizzle(sqlite) as Db, sqlite };
}

/** Why an existing database file cannot be used, or null when it is fine (or absent). */
function corruption(file: string): string | null {
  if (file === ':memory:' || !existsSync(file)) return null;
  let probe: Database.Database | undefined;
  try {
    probe = new Database(file);
    // As in `configure`: never map the shared-memory file.
    probe.pragma('locking_mode = EXCLUSIVE');
    const result = probe.pragma('quick_check', { simple: true });
    return result === 'ok' ? null : String(result);
  } catch (err) {
    return (err as Error).message;
  } finally {
    try {
      probe?.close();
    } catch {
      // Closing a malformed database can throw as well; it is being replaced.
    }
  }
}

function applyMigrations(sqlite: Database.Database, name: string, migrations: string[]): void {
  const row = sqlite.prepare('SELECT version FROM schema_versions WHERE name = ?').get(name) as
    | { version: number }
    | undefined;
  const record = sqlite.prepare(
    `INSERT INTO schema_versions (name, version) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
  );
  for (let version = row?.version ?? 0; version < migrations.length; version++) {
    sqlite.transaction(() => {
      sqlite.exec(migrations[version]);
      record.run(name, version + 1);
    })();
  }
}
