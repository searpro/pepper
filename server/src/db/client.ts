import { openDb as openCoreDb, type OpenDbResult } from '../core/db/client.js';
import { PEPPER_MIGRATIONS, PEPPER_SCHEMA_SQL } from './schema.js';

export type { Db } from '../core/db/client.js';

/** Open Pepper's database: the shared tables plus Pepper's own. */
export function openDb(file: string, onRecovered?: (movedTo: string, reason: string) => void): OpenDbResult {
  return openCoreDb(file, onRecovered, { name: 'pepper', sql: PEPPER_SCHEMA_SQL, migrations: PEPPER_MIGRATIONS });
}
