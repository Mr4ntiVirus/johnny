// snapshot_ledger — global record of JSONL message uuids already captured into
// a memory. Claude Code resumed sessions keep the original message uuids when
// they copy history into a new session file, so one global ledger stops both
// the trim-cursor-reset recapture and the cross-session resume recapture.
// Key on uuid only — never on content hash — so a false "seen" can't drop
// genuinely new content.

import { query, execute } from '../db-client.js';

const BATCH = 400; // stays under SQLite's 999-variable limit with headroom

export async function getLedgeredUuids(uuids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const unique = [...new Set(uuids)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const rows = await query<{ uuid: string }>(
      `SELECT uuid FROM snapshot_ledger WHERE uuid IN (${slice.map(() => '?').join(',')})`,
      slice,
    );
    for (const r of rows) seen.add(r.uuid);
  }
  return seen;
}

export async function recordLedger(
  uuids: string[],
  sessionId: string,
  memoryId: string | null,
): Promise<void> {
  const ingestedAt = new Date().toISOString();
  const unique = [...new Set(uuids)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const values = slice.map(() => '(?, ?, ?, ?)').join(',');
    const params: unknown[] = [];
    for (const u of slice) params.push(u, sessionId, memoryId, ingestedAt);
    await execute(
      `INSERT INTO snapshot_ledger (uuid, session_id, memory_id, ingested_at) VALUES ${values}
       ON CONFLICT (uuid) DO NOTHING`,
      params,
    );
  }
}

export async function getLedgerCount(): Promise<number> {
  const rows = await query<{ n: number }>('SELECT COUNT(*) AS n FROM snapshot_ledger');
  return Number(rows[0]?.n) || 0;
}
