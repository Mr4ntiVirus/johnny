// SQLite schema bootstrap: runMigrations() creates the schema, is idempotent,
// and upgrades a database created under an older schema without losing rows.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  setDatabasePath, getDatabase, runMigrations, closeDatabase,
} from '../../../src/store/database.js';

const tables = (db: ReturnType<typeof getDatabase>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(r => r.name);

describe('database.ts — migrations', () => {
  afterEach(() => { closeDatabase(); });

  it('creates the core tables on an empty in-memory database', () => {
    closeDatabase();
    setDatabasePath(':memory:');
    runMigrations();
    const names = tables(getDatabase());
    for (const t of ['memories', 'transcripts', 'edges', 'sessions', 'state', 'chunks']) {
      expect(names, t).toContain(t);
    }
  });

  it('seeds the schema_version state row exactly once', () => {
    closeDatabase();
    setDatabasePath(':memory:');
    runMigrations();
    runMigrations();
    const rows = getDatabase().prepare("SELECT value FROM state WHERE key = 'schema_version'").all();
    expect(rows).toHaveLength(1);
  });

  it('is idempotent across reopen of a file-backed database, preserving rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-db-'));
    const file = path.join(dir, 'johnny.db');
    try {
      closeDatabase();
      setDatabasePath(file);
      runMigrations();
      getDatabase().prepare("INSERT INTO state (key, value, updated_at) VALUES ('probe', 'kept', datetime('now'))").run();
      const before = tables(getDatabase()).sort();

      closeDatabase();
      setDatabasePath(file);
      runMigrations();
      expect(tables(getDatabase()).sort()).toEqual(before);
      const row = getDatabase().prepare("SELECT value FROM state WHERE key = 'probe'").get() as { value: string };
      expect(row.value).toBe('kept');
    } finally {
      closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a pre-existing database that already has some tables without clobbering its data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-db-'));
    const file = path.join(dir, 'old.db');
    try {
      const old = new Database(file);
      old.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);" +
               "INSERT INTO state VALUES ('legacy', 'yes', datetime('now'));");
      old.close();

      closeDatabase();
      setDatabasePath(file);
      runMigrations();
      const db = getDatabase();
      expect(tables(db)).toContain('memories');
      const row = db.prepare("SELECT value FROM state WHERE key = 'legacy'").get() as { value: string };
      expect(row.value).toBe('yes');
    } finally {
      closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
