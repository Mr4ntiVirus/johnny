// Local SQLite adapter — matches the interface of db-client.ts so store modules
// can use either backend transparently.
//
// Used by: hook processes (evaluate, post-turn, pre-compact) for instant local reads/writes.
// SQLite uses ? placeholders natively — no conversion needed (db-client converts ? → $N).
// All methods are async to match the db-client interface; better-sqlite3 is synchronous
// under the hood so they resolve immediately.

import { getDatabase as getDb } from './database.js';
import type Database from 'better-sqlite3';

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  return getDb().prepare(sql).all(params ?? []) as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const row = getDb().prepare(sql).get(params ?? []);
  return (row as T) ?? null;
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  getDb().prepare(sql).run(params ?? []);
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function transaction<T>(
  fn: (db: Database.Database) => Promise<T>,
): Promise<T> {
  const db = getDb();
  let result!: T;
  // better-sqlite3 transactions are synchronous; fn receives the db handle.
  const txn = db.transaction(() => {
    // Bridge: run the async fn synchronously by unwrapping
    // (hook processes never mix real async I/O inside transactions)
    const promise = fn(db);
    // Capture result synchronously (Promise resolves immediately for SQLite)
    promise.then(r => { result = r; }).catch(() => {});
    return result;
  });
  txn();
  return result;
}

// ── Watermark helpers (for sync agent) ───────────────────────────────────────

export function getLocalWatermark(): number {
  const row = getDb().prepare(
    "SELECT value FROM state WHERE key = 'last_synced_at'",
  ).get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function setLocalWatermark(ts: number): void {
  getDb().prepare(
    "INSERT INTO state (key, value, updated_at) VALUES ('last_synced_at', ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run([String(ts)]);
}
