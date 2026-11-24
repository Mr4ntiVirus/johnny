// Storage facade. Johnny is local-only: every read and write goes to the
// SQLite database at ~/.johnny/johnny.db via better-sqlite3 (see local-db.ts
// and database.ts). Store modules import from here so there is one place to
// change if the storage engine ever does.

export { query, queryOne, execute, transaction } from './local-db.js';

