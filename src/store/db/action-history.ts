// action_history — one row per evaluate() call. Append-only.

import { query, queryOne, execute } from '../db-client.js';
import { log } from '../../utils/log.js';
import type { Action } from '../../types.js';

export interface ActionHistoryInput {
  sessionId: string;
  turn: number;
  recallScore: number | null;
  cmvPressure: number | null;
  limitPressure: number | null;
  action: Action;
  matchedMemoryId: string | null;
  durationMs: number | null;
}

export interface ActionHistoryRecord {
  id: number;
  session_id: string;
  turn: number;
  ts: string;
  intent: string | null;
  confidence: string | null;
  cmv_pressure: number | null;
  limit_pressure: number | null;
  action: string;
  matched_memory_id: string | null;
  duration_ms: number | null;
}

export async function recordAction(input: ActionHistoryInput): Promise<void> {
  const sql = `INSERT INTO action_history
      (session_id, turn, ts, recall_score, cmv_pressure, limit_pressure, action, matched_memory_id, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    input.sessionId, input.turn, new Date().toISOString(),
    input.recallScore, input.cmvPressure, input.limitPressure,
    input.action, input.matchedMemoryId, input.durationMs,
  ];

  // Best-effort telemetry: a write failure must not throw into the hook path.
  await execute(sql, params).catch((err) => log(`recordAction write failed: ${err}`));
}

export async function getRecentActions(limit = 100): Promise<ActionHistoryRecord[]> {
  return query<ActionHistoryRecord>('SELECT * FROM action_history ORDER BY ts DESC LIMIT ?', [limit]);
}

export interface ActionCount {
  action: string;
  count: number;
  lastFiredAt: string | null;
}

export async function getActionDistribution(lastN = 100): Promise<ActionCount[]> {
  return query<ActionCount>(
    `SELECT action, COUNT(*) AS count, MAX(ts) AS lastFiredAt
     FROM (SELECT action, ts FROM action_history ORDER BY ts DESC LIMIT ?)
     GROUP BY action
     ORDER BY count DESC`,
    [lastN],
  );
}

export async function getLastFiredAt(action: Action): Promise<string | null> {
  const row = await queryOne<{ ts: string }>(
    'SELECT ts FROM action_history WHERE action = ? ORDER BY ts DESC LIMIT 1',
    [action],
  );
  return row?.ts ?? null;
}

export async function countActionSince(action: Action, sinceIso: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM action_history WHERE action = ? AND ts >= ?',
    [action, sinceIso],
  );
  return row?.n ?? 0;
}
