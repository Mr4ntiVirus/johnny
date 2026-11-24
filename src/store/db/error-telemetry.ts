// error_telemetry — append-only record of caught errors that would otherwise
// be silently swallowed.

import { query, queryOne, execute } from '../db-client.js';

export type ErrorSeverity = 'benign' | 'warning' | 'error' | 'fatal';

export interface ErrorTelemetryInput {
  source: string;
  severity: ErrorSeverity;
  message: string;
  sessionId?: string;
}

export interface ErrorTelemetryRecord {
  id: number;
  ts: string;
  source: string;
  severity: ErrorSeverity;
  message: string;
  session_id: string | null;
}

// Fire-and-forget — must never throw. Callers rely on this being synchronous-safe.
export function logError(input: ErrorTelemetryInput): void {
  execute(
    'INSERT INTO error_telemetry (ts, source, severity, message, session_id) VALUES (?, ?, ?, ?, ?)',
    [new Date().toISOString(), input.source, input.severity, input.message.slice(0, 500), input.sessionId ?? null],
  ).catch(() => { /* must not throw */ });
}

export async function getRecentErrors(limit = 100): Promise<ErrorTelemetryRecord[]> {
  return query<ErrorTelemetryRecord>('SELECT * FROM error_telemetry ORDER BY ts DESC LIMIT ?', [limit]);
}

export interface ErrorRollup {
  source: string;
  severity: ErrorSeverity;
  count: number;
}

export async function getErrorRollup(sinceIso: string): Promise<ErrorRollup[]> {
  return query<ErrorRollup>(
    `SELECT source, severity, COUNT(*) AS count
     FROM error_telemetry
     WHERE ts >= ?
     GROUP BY source, severity
     ORDER BY count DESC`,
    [sinceIso],
  );
}

export async function countErrorsSince(sinceIso: string, severity?: ErrorSeverity): Promise<number> {
  if (severity) {
    const row = await queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM error_telemetry WHERE ts >= ? AND severity = ?',
      [sinceIso, severity],
    );
    return row?.n ?? 0;
  }
  const row = await queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM error_telemetry WHERE ts >= ?',
    [sinceIso],
  );
  return row?.n ?? 0;
}
