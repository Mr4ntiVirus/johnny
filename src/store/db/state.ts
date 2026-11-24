import { query, queryOne, execute } from '../db-client.js';

export async function getState(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>('SELECT value FROM state WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    `INSERT INTO state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

export async function getTurnCounter(): Promise<number> {
  const value = await getState('turn_counter');
  return value ? parseInt(value, 10) : 0;
}

export async function incrementTurn(): Promise<number> {
  const current = await getTurnCounter();
  const next = current + 1;
  await setState('turn_counter', next.toString());
  return next;
}

export async function getRankUpdatedTurn(): Promise<number> {
  const value = await getState('rank_updated_turn');
  return value ? parseInt(value, 10) : 0;
}

export async function setRankUpdatedTurn(turn: number): Promise<void> {
  await setState('rank_updated_turn', turn.toString());
}

export async function getSchemaVersion(): Promise<number> {
  const value = await getState('schema_version');
  return value ? parseInt(value, 10) : 0;
}

const SCHEMA_VERSION = '2';

export async function initState(): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getState('turn_counter');
  if (existing === null) {
    await execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', ['turn_counter', '0', now]);
    await execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', ['rank_updated_turn', '0', now]);
    await execute('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)', ['schema_version', SCHEMA_VERSION, now]);
  }
}
