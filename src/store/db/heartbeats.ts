// daemon_heartbeats — each daemon subsystem writes a heartbeat row on every
// tick, regardless of whether it did real work. The observability dashboard
// reads `last_pulse` to render "✓ 8s ago" or "✗ stalled 3m" indicators.
//
// Two timestamps:
//   last_pulse — "I'm alive" (every tick)
//   last_work  — "I did real work" (only when the subsystem performed an action)

import { query, queryOne, execute } from '../db-client.js';

export type SubsystemName =
  | 'model-warmer'
  | 'watcher'
  | 'rank-refresher'
  | 'idle-trigger'
  | 'mcp-watcher'
  | 'embed-backfill';

export type SubsystemStatus = 'ok' | 'stalled' | 'error';

export interface HeartbeatRecord {
  subsystem: string;
  last_pulse: string;
  last_work: string | null;
  status: SubsystemStatus;
}

// Fire-and-forget — callers never await heartbeats.
// Writes go to the local SQLite store (doctor reads from here).
export function recordHeartbeat(
  subsystem: SubsystemName,
  opts: { didWork?: boolean; status?: SubsystemStatus } = {},
): void {
  const now = new Date().toISOString();
  const status = opts.status ?? 'ok';
  if (opts.didWork) {
    const sql = `INSERT INTO daemon_heartbeats (subsystem, last_pulse, last_work, status)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(subsystem) DO UPDATE SET
         last_pulse = excluded.last_pulse,
         last_work = excluded.last_work,
         status = excluded.status`;
    execute(sql, [subsystem, now, now, status]).catch(() => {});
  } else {
    const sql = `INSERT INTO daemon_heartbeats (subsystem, last_pulse, status)
       VALUES (?, ?, ?)
       ON CONFLICT(subsystem) DO UPDATE SET
         last_pulse = excluded.last_pulse,
         status = excluded.status`;
    execute(sql, [subsystem, now, status]).catch(() => {});
  }
}

export async function getHeartbeats(): Promise<HeartbeatRecord[]> {
  return query<HeartbeatRecord>('SELECT * FROM daemon_heartbeats ORDER BY subsystem');
}

export async function getHeartbeat(subsystem: SubsystemName): Promise<HeartbeatRecord | null> {
  return queryOne<HeartbeatRecord>('SELECT * FROM daemon_heartbeats WHERE subsystem = ?', [subsystem]);
}
