import { query, queryOne, execute } from '../db-client.js';

// Shared cooldown used by both evaluate.ts (UserPromptSubmit) and post-turn.ts
// (PostToolUse) so they coordinate on the same per-session snapshot window.
export const DEFAULT_SNAPSHOT_COOLDOWN_MS = 120_000;

export interface SessionInput {
  sessionId: string;
  projectPath?: string;
  activeMemoryId?: string;
  lastCwd?: string;
  lastAction?: string;
}

export interface SessionRecord {
  session_id: string;
  project_path: string | null;
  last_prompt_at: string | null;
  last_cwd: string | null;
  last_action: string | null;
  active_memory_id: string | null;
  surfaced_memories: string | null;
  recalled_memory_ids: string | null;
  ask_candidates: string | null;
  last_turn: number;
}

export async function createSession(input: SessionInput): Promise<void> {
  await execute(
    `INSERT INTO sessions (session_id, project_path, last_prompt_at, last_cwd, last_action, active_memory_id, last_turn)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [input.sessionId, input.projectPath ?? null, new Date().toISOString(), input.lastCwd ?? null, input.lastAction ?? null, input.activeMemoryId ?? null],
  );
}

export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
}

export async function upsertSession(input: SessionInput): Promise<void> {
  const existing = await getSession(input.sessionId);
  if (existing) {
    await updateSession(input.sessionId, input);
  } else {
    await createSession(input);
  }
}

export async function updateSession(sessionId: string, updates: Partial<SessionInput>): Promise<void> {
  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: (string | null)[] = [];

  if (updates.projectPath !== undefined) { fields.push('project_path = ?'); values.push(updates.projectPath); }
  if (updates.activeMemoryId !== undefined) { fields.push('active_memory_id = ?'); values.push(updates.activeMemoryId); }
  if (updates.lastCwd !== undefined) { fields.push('last_cwd = ?'); values.push(updates.lastCwd); }
  if (updates.lastAction !== undefined) { fields.push('last_action = ?'); values.push(updates.lastAction); }

  fields.push('last_prompt_at = ?');
  values.push(now);

  if (fields.length === 1) return;

  values.push(sessionId);
  await execute(`UPDATE sessions SET ${fields.join(', ')} WHERE session_id = ?`, values);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
}

export async function getActiveSession(): Promise<SessionRecord | null> {
  return queryOne<SessionRecord>('SELECT * FROM sessions ORDER BY last_prompt_at DESC LIMIT 1');
}

export async function getAllSessions(): Promise<SessionRecord[]> {
  return query<SessionRecord>('SELECT * FROM sessions ORDER BY last_prompt_at DESC');
}

export async function getSessionTurn(sessionId: string): Promise<number> {
  const row = await getSession(sessionId);
  return row?.last_turn ?? 0;
}

export async function incrementSessionTurn(sessionId: string): Promise<number> {
  const existing = await getSession(sessionId);
  if (!existing) await createSession({ sessionId });
  await execute(
    'UPDATE sessions SET last_turn = last_turn + 1, last_prompt_at = ? WHERE session_id = ?',
    [new Date().toISOString(), sessionId],
  );
  return getSessionTurn(sessionId);
}

// ── Surfaced memories ────────────────────────────────────────────────────────

export async function getSurfacedMap(sessionId: string): Promise<Record<string, number>> {
  const row = await getSession(sessionId);
  if (!row?.surfaced_memories) return {};
  try {
    const parsed = JSON.parse(row.surfaced_memories);
    if (Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const id of parsed) if (typeof id === 'string') out[id] = 0;
      return out;
    }
    if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
    return {};
  } catch { return {}; }
}

export async function getSurfacedMemories(sessionId: string): Promise<string[]> {
  return Object.keys(await getSurfacedMap(sessionId));
}

export async function getMemorySurfaceTurn(sessionId: string, memoryId: string): Promise<number | null> {
  const map = await getSurfacedMap(sessionId);
  return Object.prototype.hasOwnProperty.call(map, memoryId) ? map[memoryId] : null;
}

async function writeSurfacedMap(sessionId: string, map: Record<string, number>): Promise<void> {
  const existing = await getSession(sessionId);
  if (!existing) await createSession({ sessionId });
  await execute('UPDATE sessions SET surfaced_memories = ? WHERE session_id = ?', [JSON.stringify(map), sessionId]);
}

export async function setSurfacedMemories(sessionId: string, ids: string[]): Promise<void> {
  const turn = await getSessionTurn(sessionId);
  const map: Record<string, number> = {};
  for (const id of ids) map[id] = turn;
  await writeSurfacedMap(sessionId, map);
}

export async function setMemorySurfaced(sessionId: string, id: string, turn: number): Promise<void> {
  const map = await getSurfacedMap(sessionId);
  map[id] = turn;
  await writeSurfacedMap(sessionId, map);
}

/**
 * After a compaction the primed knowledge is no longer in Claude's context, so
 * its cooldown entries must be dropped: the next relevant prompt may re-prime it.
 */
export async function clearKnowledgeSurfaced(sessionId: string): Promise<number> {
  const map = await getSurfacedMap(sessionId);
  const keep: Record<string, number> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(map)) {
    if (/^(model|obs|fact):/.test(k)) dropped++; else keep[k] = v;
  }
  if (dropped > 0) await writeSurfacedMap(sessionId, keep);
  return dropped;
}

export async function addSurfacedMemory(sessionId: string, id: string): Promise<void> {
  await setMemorySurfaced(sessionId, id, await getSessionTurn(sessionId));
}

// ── Recalled memory IDs ──────────────────────────────────────────────────────

export async function getRecalledMemoryIds(sessionId: string): Promise<string[]> {
  const row = await getSession(sessionId);
  if (!row?.recalled_memory_ids) return [];
  try { return JSON.parse(row.recalled_memory_ids) as string[]; } catch { return []; }
}

export async function setRecalledMemoryIds(sessionId: string, ids: string[]): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET recalled_memory_ids = ? WHERE session_id = ?', [JSON.stringify(ids), sessionId]);
}

export async function addRecalledMemoryId(sessionId: string, id: string): Promise<void> {
  const current = await getRecalledMemoryIds(sessionId);
  if (!current.includes(id)) await setRecalledMemoryIds(sessionId, [...current, id]);
}

export async function clearRecalledMemoryIds(sessionId: string): Promise<void> {
  if (!(await getSession(sessionId))) return;
  await execute('UPDATE sessions SET recalled_memory_ids = NULL WHERE session_id = ?', [sessionId]);
}

// ── Delta snapshot line tracking ─────────────────────────────────────────────

export async function getLastSnapshotLine(sessionId: string): Promise<number> {
  const row = await queryOne<{ last_snapshot_line: number }>(
    'SELECT last_snapshot_line FROM sessions WHERE session_id = ?',
    [sessionId],
  );
  return row?.last_snapshot_line ?? 0;
}

export async function setLastSnapshotLine(sessionId: string, lineCount: number): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET last_snapshot_line = ? WHERE session_id = ?', [lineCount, sessionId]);
}

// Content anchor for the delta cursor: the uuid of the last JSONL message this
// session captured. Unlike a line number it survives trims, compaction and
// resumed-session file rewrites (see snapshot_ledger for the global guard).
export async function getLastSnapshotUuid(sessionId: string): Promise<string | null> {
  const row = await queryOne<{ last_snapshot_uuid: string | null }>(
    'SELECT last_snapshot_uuid FROM sessions WHERE session_id = ?',
    [sessionId],
  );
  return row?.last_snapshot_uuid ?? null;
}

export async function setLastSnapshotUuid(sessionId: string, uuid: string): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET last_snapshot_uuid = ? WHERE session_id = ?', [uuid, sessionId]);
}

// ── Snapshot rate limit ──────────────────────────────────────────────────────

export async function getLastSnapshotAt(sessionId: string): Promise<Date | null> {
  const row = await queryOne<{ last_snapshot_at: string | null }>(
    'SELECT last_snapshot_at FROM sessions WHERE session_id = ?',
    [sessionId],
  );
  if (!row?.last_snapshot_at) return null;
  return new Date(row.last_snapshot_at);
}

export async function setLastSnapshotAt(sessionId: string, when: Date = new Date()): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET last_snapshot_at = ? WHERE session_id = ?', [when.toISOString(), sessionId]);
}

// ── Trim rate limit ──────────────────────────────────────────────────────────

export async function getLastTrimAt(sessionId: string): Promise<Date | null> {
  const row = await queryOne<{ last_trim_at: string | null }>(
    'SELECT last_trim_at FROM sessions WHERE session_id = ?',
    [sessionId],
  );
  if (!row?.last_trim_at) return null;
  return new Date(row.last_trim_at);
}

export async function setLastTrimAt(sessionId: string, when: Date = new Date()): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET last_trim_at = ? WHERE session_id = ?', [when.toISOString(), sessionId]);
}

// ── Atomic cooldown claims ───────────────────────────────────────────────────

// Atomically claim the trim window for a session. Returns true only for the
// one concurrent caller whose UPDATE wins the race; all others see elapsed < cooldown.
//
// Uses JS-computed ISO timestamps instead of NOW() / ::timestamptz / INTERVAL
// so the query is portable SQL. ISO string comparison is lexicographically correct for UTC.
export async function claimTrimWindow(sessionId: string, cooldownMs: number): Promise<boolean> {
  const now = new Date().toISOString();
  const threshold = new Date(Date.now() - cooldownMs).toISOString();
  const rows = await query<{ session_id: string }>(
    `UPDATE sessions SET last_trim_at = ?
     WHERE session_id = ?
       AND (last_trim_at IS NULL OR last_trim_at < ?)
     RETURNING session_id`,
    [now, sessionId, threshold],
  );
  return rows.length > 0;
}

export async function claimSnapshotWindow(sessionId: string, cooldownMs: number): Promise<boolean> {
  const now = new Date().toISOString();
  const threshold = new Date(Date.now() - cooldownMs).toISOString();
  const rows = await query<{ session_id: string }>(
    `UPDATE sessions SET last_snapshot_at = ?
     WHERE session_id = ?
       AND (last_snapshot_at IS NULL OR last_snapshot_at < ?)
     RETURNING session_id`,
    [now, sessionId, threshold],
  );
  return rows.length > 0;
}

// ── Ask candidates ───────────────────────────────────────────────────────────

export async function getAskCandidates(sessionId: string): Promise<string[]> {
  const row = await getSession(sessionId);
  if (!row?.ask_candidates) return [];
  try { return JSON.parse(row.ask_candidates) as string[]; } catch { return []; }
}

export async function setAskCandidates(sessionId: string, ids: string[]): Promise<void> {
  if (!(await getSession(sessionId))) await createSession({ sessionId });
  await execute('UPDATE sessions SET ask_candidates = ? WHERE session_id = ?', [JSON.stringify(ids), sessionId]);
}
