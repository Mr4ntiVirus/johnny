// job_state — atomic claims, watermarks, pending flags and failure-pause for
// every background knowledge step (extract / consolidate / models / dedupe).
// Dual-dialect: ISO-string timestamps computed in JS, UPDATE ... RETURNING
// for the atomic claim (same pattern as claimSnapshotWindow in sessions.ts).

import { query, queryOne, execute } from '../db-client.js';

export interface JobRecord {
  job: string;
  scope: string;
  watermark: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  pending: number;
  fail_count: number;
  paused: number;
  last_error: string | null;
  stats: string | null;
  updated_at: string;
}

export const DEFAULT_CLAIM_TTL_MS = 30 * 60_000;
export const FAILURE_PAUSE_THRESHOLD = 3;

const now = () => new Date().toISOString();

async function ensureRow(job: string, scope: string): Promise<void> {
  await execute(
    `INSERT INTO job_state (job, scope, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (job, scope) DO NOTHING`,
    [job, scope, now()],
  );
}

export async function getJob(job: string, scope = ''): Promise<JobRecord | null> {
  return queryOne<JobRecord>('SELECT * FROM job_state WHERE job = ? AND scope = ?', [job, scope]);
}

export async function listJobs(job?: string): Promise<JobRecord[]> {
  return job
    ? query<JobRecord>('SELECT * FROM job_state WHERE job = ? ORDER BY scope', [job])
    : query<JobRecord>('SELECT * FROM job_state ORDER BY job, scope');
}

/**
 * Atomically claim (job, scope). Returns true only for the one caller whose
 * UPDATE wins. A claim older than ttlMs is considered abandoned (crashed
 * worker) and can be re-claimed. Paused jobs are never claimed.
 */
export async function claimJob(
  job: string,
  scope: string,
  owner: string,
  ttlMs = DEFAULT_CLAIM_TTL_MS,
): Promise<boolean> {
  await ensureRow(job, scope);
  const stamp = now();
  const stale = new Date(Date.now() - ttlMs).toISOString();
  const rows = await query<{ job: string }>(
    `UPDATE job_state SET claimed_by = ?, claimed_at = ?, updated_at = ?
     WHERE job = ? AND scope = ? AND paused = 0
       AND (claimed_at IS NULL OR claimed_at < ?)
     RETURNING job`,
    [owner, stamp, stamp, job, scope, stale],
  );
  return rows.length > 0;
}

export async function releaseJob(job: string, scope: string, owner: string): Promise<void> {
  await execute(
    `UPDATE job_state SET claimed_by = NULL, claimed_at = NULL, updated_at = ?
     WHERE job = ? AND scope = ? AND claimed_by = ?`,
    [now(), job, scope, owner],
  );
}

export async function setPending(job: string, scope: string, pending: boolean): Promise<void> {
  await ensureRow(job, scope);
  await execute(
    'UPDATE job_state SET pending = ?, updated_at = ? WHERE job = ? AND scope = ?',
    [pending ? 1 : 0, now(), job, scope],
  );
}

export async function setWatermark(job: string, scope: string, watermark: string): Promise<void> {
  await ensureRow(job, scope);
  await execute(
    'UPDATE job_state SET watermark = ?, updated_at = ? WHERE job = ? AND scope = ?',
    [watermark, now(), job, scope],
  );
}

export async function recordStats(job: string, scope: string, stats: Record<string, unknown>): Promise<void> {
  await ensureRow(job, scope);
  await execute(
    'UPDATE job_state SET stats = ?, updated_at = ? WHERE job = ? AND scope = ?',
    [JSON.stringify(stats), now(), job, scope],
  );
}

export async function recordSuccess(job: string, scope: string): Promise<void> {
  await ensureRow(job, scope);
  await execute(
    `UPDATE job_state SET fail_count = 0, last_error = NULL, paused = 0, updated_at = ?
     WHERE job = ? AND scope = ?`,
    [now(), job, scope],
  );
}

/** Increment failures; auto-pause once the threshold is hit. Returns whether it is now paused. */
export async function recordFailure(
  job: string,
  scope: string,
  error: string,
  threshold = FAILURE_PAUSE_THRESHOLD,
): Promise<boolean> {
  await ensureRow(job, scope);
  await execute(
    `UPDATE job_state SET fail_count = fail_count + 1, last_error = ?, updated_at = ?
     WHERE job = ? AND scope = ?`,
    [error.slice(0, 500), now(), job, scope],
  );
  const row = await getJob(job, scope);
  if (row && row.fail_count >= threshold && !row.paused) {
    await execute('UPDATE job_state SET paused = 1, updated_at = ? WHERE job = ? AND scope = ?', [now(), job, scope]);
    return true;
  }
  return !!row?.paused;
}

export async function pauseJob(job: string, scope: string, reason: string): Promise<void> {
  await ensureRow(job, scope);
  await execute(
    'UPDATE job_state SET paused = 1, last_error = ?, updated_at = ? WHERE job = ? AND scope = ?',
    [reason.slice(0, 500), now(), job, scope]);
}

export async function resume(job: string, scope: string): Promise<void> {
  await execute(
    'UPDATE job_state SET paused = 0, fail_count = 0, last_error = NULL, updated_at = ? WHERE job = ? AND scope = ?',
    [now(), job, scope],
  );
}

export async function anyPending(job?: string): Promise<boolean> {
  const row = job
    ? await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM job_state WHERE job = ? AND pending = 1 AND paused = 0', [job])
    : await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM job_state WHERE pending = 1 AND paused = 0');
  return (Number(row?.n) || 0) > 0;
}
