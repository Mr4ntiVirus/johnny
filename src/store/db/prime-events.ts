// prime_events — one row per priming decision, so the doctor can show real
// fired-over-evaluated rates and surface failures that are otherwise swallowed.
// Writes are best-effort (never throw into a hook) and pruned to RETAIN_DAYS.

import { randomUUID } from 'node:crypto';
import { query, execute } from '../db-client.js';

export type PrimeOutcome = 'primed' | 'none' | 'failed';
export type PrimeEventTrigger = 'first-prompt' | 'topic-switch' | 'continuation' | 'tool';
export const PRIME_RETAIN_DAYS = 30;
const PRUNE_EVERY = 50; // prune on roughly 1 in N writes; cheap, keeps the table bounded

export interface PrimeEventInput {
  sessionId?: string | null;
  trigger: PrimeEventTrigger;
  outcome: PrimeOutcome;
  refs?: string[];
  topScore?: number | null;
  error?: string | null;
}

export async function recordPrimeEvent(e: PrimeEventInput): Promise<void> {
  try {
    await execute(
      `INSERT INTO prime_events (id, created_at, session_id, trigger, outcome, refs, top_score, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), new Date().toISOString(), e.sessionId ?? null, e.trigger, e.outcome,
        e.refs?.length ? e.refs.join(',') : null, e.topScore ?? null, e.error ? e.error.slice(0, 300) : null]);
    if (Math.random() < 1 / PRUNE_EVERY) {
      const cutoff = new Date(Date.now() - PRIME_RETAIN_DAYS * 86_400_000).toISOString();
      await execute('DELETE FROM prime_events WHERE created_at < ?', [cutoff]);
    }
  } catch { /* observability only — never affect the hook */ }
}

export interface PrimeWindowStats { evaluated: number; primed: number; failed: number }

export async function getPrimeStats(sinceIso: string): Promise<PrimeWindowStats> {
  const rows = await query<{ outcome: string; n: number }>(
    'SELECT outcome, COUNT(*) AS n FROM prime_events WHERE created_at >= ? GROUP BY outcome', [sinceIso]);
  const by = (o: string) => Number(rows.find(r => r.outcome === o)?.n) || 0;
  const primed = by('primed'), failed = by('failed');
  return { evaluated: primed + failed + by('none'), primed, failed };
}

export async function getLastPrimeEvent(): Promise<{ created_at: string; outcome: string; error: string | null } | null> {
  const rows = await query<{ created_at: string; outcome: string; error: string | null }>(
    `SELECT created_at, outcome, error FROM prime_events ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}
