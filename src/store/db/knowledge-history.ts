// knowledge_history — version snapshots for observations and mental models
// (the content BEFORE a change), capped per ref so it can't grow unbounded.

import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../db-client.js';

export type HistoryKind = 'observation' | 'model';
export const HISTORY_CAP = 50;

export interface HistoryRecord {
  id: string;
  kind: HistoryKind;
  ref_id: string;
  version: number;
  content: string | null;
  reason: string | null;
  created_at: string;
}

export async function addHistory(kind: HistoryKind, refId: string, content: string | null, reason: string): Promise<void> {
  const last = await queryOne<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM knowledge_history WHERE kind = ? AND ref_id = ?', [kind, refId]);
  const version = (Number(last?.v) || 0) + 1;
  await execute(
    `INSERT INTO knowledge_history (id, kind, ref_id, version, content, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), kind, refId, version, content, reason.slice(0, 500), new Date().toISOString()]);
  if (version > HISTORY_CAP) {
    await execute(
      'DELETE FROM knowledge_history WHERE kind = ? AND ref_id = ? AND version <= ?',
      [kind, refId, version - HISTORY_CAP]);
  }
}

export async function getHistory(kind: HistoryKind, refId: string, limit = 20): Promise<HistoryRecord[]> {
  return query<HistoryRecord>(
    'SELECT * FROM knowledge_history WHERE kind = ? AND ref_id = ? ORDER BY version DESC LIMIT ?',
    [kind, refId, limit]);
}
