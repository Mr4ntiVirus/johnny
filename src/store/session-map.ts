// Thin wrapper over db/sessions.ts + db/state.ts.

import type { SessionMap, SessionMapEntry, MemoryId, Action } from '../types.js';
import * as dbSessions from './db/sessions.js';
import { getState, setState } from './db/state.js';

function rowToEntry(row: dbSessions.SessionRecord): SessionMapEntry {
  return {
    memoryId: (row.active_memory_id as MemoryId | null) ?? null,
    projectPath: row.project_path ?? '',
    lastPromptAt: row.last_prompt_at ?? '',
    lastCwd: row.last_cwd ?? '',
    lastAction: (row.last_action as Action | undefined) ?? undefined,
    surfacedMemories: parseIds(row.surfaced_memories),
  };
}

function parseIds(raw: string | null): MemoryId[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MemoryId[]) : undefined;
  } catch { return undefined; }
}

export async function readSessionMap(): Promise<SessionMap> {
  const rows = await dbSessions.getAllSessions();
  const activeSessionId = await getState('active_session');
  const out: SessionMap = { activeSessionId, sessions: {} };
  for (const row of rows) {
    out.sessions[row.session_id] = rowToEntry(row);
  }
  return out;
}

export async function setActiveSession(
  sessionId: string,
  cwd: string,
  memoryId: MemoryId | null,
  lastAction?: Action,
  newSurfaced?: MemoryId[],
): Promise<void> {
  await dbSessions.upsertSession({
    sessionId,
    projectPath: cwd,
    activeMemoryId: memoryId ?? undefined,
    lastCwd: cwd,
    lastAction: lastAction ?? undefined,
  });
  await setState('active_session', sessionId);

  if (newSurfaced?.length) {
    for (const id of newSurfaced) await dbSessions.addSurfacedMemory(sessionId, id);
  }
}

export async function getSessionEntry(sessionId: string): Promise<SessionMapEntry | null> {
  const row = await dbSessions.getSession(sessionId);
  return row ? rowToEntry(row) : null;
}

export async function hasMemoryBeenSurfaced(sessionId: string, memoryId: MemoryId): Promise<boolean> {
  const surfaced = await dbSessions.getSurfacedMemories(sessionId);
  return surfaced.includes(memoryId);
}

export async function recordMemorySurfaced(sessionId: string, memoryId: MemoryId): Promise<void> {
  await dbSessions.addSurfacedMemory(sessionId, memoryId);
}
