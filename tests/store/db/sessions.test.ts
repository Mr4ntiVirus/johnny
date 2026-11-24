import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as sessionsDb from '../../../src/store/db/sessions.js';
import * as memoriesDb from '../../../src/store/db/memories.js';
import { execute } from '../../../src/store/db-client.js';

describe('db/sessions.ts', () => {
  useTestDb();

  it('createSession persists with defaults', async () => {
    await sessionsDb.createSession({ sessionId: 's1', projectPath: '/tmp/proj' });
    const row = await sessionsDb.getSession('s1');
    expect(row?.session_id).toBe('s1');
    expect(row?.project_path).toBe('/tmp/proj');
    expect(row?.last_prompt_at).toBeTruthy();
    expect(row?.active_memory_id).toBeNull();
  });

  it('getSession returns null for missing id', async () => {
    expect(await sessionsDb.getSession('nope')).toBeNull();
  });

  it('PK(session_id) prevents duplicate createSession', async () => {
    await sessionsDb.createSession({ sessionId: 'dup' });
    await expect(sessionsDb.createSession({ sessionId: 'dup' })).rejects.toThrow();
  });

  it('updateSession overwrites projectPath', async () => {
    await sessionsDb.createSession({ sessionId: 's', projectPath: '/old' });
    await sessionsDb.updateSession('s', { projectPath: '/new' });
    expect((await sessionsDb.getSession('s'))?.project_path).toBe('/new');
  });

  it('updateSession sets active_memory_id (FK to memories)', async () => {
    const memId = await memoriesDb.createMemory({
      snapshotName: 'm',
      title: 'M',
      contentType: 'text',
      projectPath: '/tmp',
      tokenCount: 1,
      createdAtTurn: 1,
    });
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.updateSession('s', { activeMemoryId: memId });
    expect((await sessionsDb.getSession('s'))?.active_memory_id).toBe(memId);
  });

  it('updateSession bumps last_prompt_at when any field changes', async () => {
    await sessionsDb.createSession({ sessionId: 's', projectPath: '/a' });
    const t0 = (await sessionsDb.getSession('s'))!.last_prompt_at!;
    await new Promise(r => setTimeout(r, 5));
    await sessionsDb.updateSession('s', { projectPath: '/b' });
    const t1 = (await sessionsDb.getSession('s'))!.last_prompt_at!;
    expect(t1 >= t0).toBe(true);
  });

  it('getActiveSession returns the most recently touched session', async () => {
    await sessionsDb.createSession({ sessionId: 'old' });
    await new Promise(r => setTimeout(r, 5));
    await sessionsDb.createSession({ sessionId: 'new' });
    const active = await sessionsDb.getActiveSession();
    expect(active?.session_id).toBe('new');
  });

  it('getAllSessions returns all rows sorted by last_prompt_at desc', async () => {
    await sessionsDb.createSession({ sessionId: 'a' });
    await new Promise(r => setTimeout(r, 5));
    await sessionsDb.createSession({ sessionId: 'b' });
    const all = await sessionsDb.getAllSessions();
    expect(all.map(r => r.session_id)).toEqual(['b', 'a']);
  });

  it('deleteSession removes the row', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.deleteSession('s');
    expect(await sessionsDb.getSession('s')).toBeNull();
  });

  it('surfacedMemories round-trips JSON array', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setSurfacedMemories('s', ['m1', 'm2']);
    expect(await sessionsDb.getSurfacedMemories('s')).toEqual(['m1', 'm2']);
  });

  it('addSurfacedMemory dedupes', async () => {
    await sessionsDb.addSurfacedMemory('s', 'm1');
    await sessionsDb.addSurfacedMemory('s', 'm1');
    await sessionsDb.addSurfacedMemory('s', 'm2');
    expect(await sessionsDb.getSurfacedMemories('s')).toEqual(['m1', 'm2']);
  });

  it('recalledMemoryIds round-trips and dedupes', async () => {
    await sessionsDb.addRecalledMemoryId('s', 'm1');
    await sessionsDb.addRecalledMemoryId('s', 'm2');
    await sessionsDb.addRecalledMemoryId('s', 'm1');
    expect(await sessionsDb.getRecalledMemoryIds('s')).toEqual(['m1', 'm2']);
  });

  it('surfaced and recalled lists are independent', async () => {
    await sessionsDb.addSurfacedMemory('s', 'pushed');
    await sessionsDb.addRecalledMemoryId('s', 'pulled');
    expect(await sessionsDb.getSurfacedMemories('s')).toEqual(['pushed']);
    expect(await sessionsDb.getRecalledMemoryIds('s')).toEqual(['pulled']);
  });

  it('addSurfacedMemory stamps the entry at the current session turn', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.incrementSessionTurn('s'); // turn = 1
    await sessionsDb.incrementSessionTurn('s'); // turn = 2
    await sessionsDb.addSurfacedMemory('s', 'm1');
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'm1')).toBe(2);
  });

  it('re-surfacing the same memory updates the turn (cooldown re-arm)', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.incrementSessionTurn('s'); // 1
    await sessionsDb.addSurfacedMemory('s', 'm1');
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'm1')).toBe(1);
    await sessionsDb.incrementSessionTurn('s'); // 2
    await sessionsDb.incrementSessionTurn('s'); // 3
    await sessionsDb.addSurfacedMemory('s', 'm1');
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'm1')).toBe(3);
  });

  it('setMemorySurfaced writes a specific turn', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setMemorySurfaced('s', 'm1', 42);
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'm1')).toBe(42);
  });

  it('getMemorySurfaceTurn returns null for unsurfaced memories', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'never')).toBeNull();
  });

  it('legacy array shape parses as map with all entries at turn 0', async () => {
    // Simulate legacy data by writing the old array shape directly.
    await sessionsDb.createSession({ sessionId: 's' });
    await execute(
      'UPDATE sessions SET surfaced_memories = ? WHERE session_id = ?',
      [JSON.stringify(['legacy1', 'legacy2']), 's'],
    );

    const map = await sessionsDb.getSurfacedMap('s');
    expect(map).toEqual({ legacy1: 0, legacy2: 0 });
    expect((await sessionsDb.getSurfacedMemories('s')).sort()).toEqual(['legacy1', 'legacy2']);
  });

  it('writes always emit map shape, even when caller passes a flat list', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.incrementSessionTurn('s'); // turn = 1
    await sessionsDb.setSurfacedMemories('s', ['a', 'b']);
    const map = await sessionsDb.getSurfacedMap('s');
    expect(map).toEqual({ a: 1, b: 1 });
  });

  it('clearRecalledMemoryIds resets the recall set without touching surfaced', async () => {
    await sessionsDb.addSurfacedMemory('s', 'pushed');
    await sessionsDb.addRecalledMemoryId('s', 'm1');
    await sessionsDb.addRecalledMemoryId('s', 'm2');

    await sessionsDb.clearRecalledMemoryIds('s');

    expect(await sessionsDb.getRecalledMemoryIds('s')).toEqual([]);
    expect(await sessionsDb.getSurfacedMemories('s')).toEqual(['pushed']);
  });

  it('clearRecalledMemoryIds is a no-op on unknown sessions', async () => {
    await expect(sessionsDb.clearRecalledMemoryIds('does-not-exist')).resolves.not.toThrow();
  });

  // ── Delta snapshot cursor ────────────────────────────────────────────────────

  it('getLastSnapshotLine returns 0 for a session with no row', async () => {
    // No createSession call — session does not exist in DB yet.
    expect(await sessionsDb.getLastSnapshotLine('brand-new-session')).toBe(0);
  });

  it('getLastSnapshotLine returns 0 for an existing session before any snapshot', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    expect(await sessionsDb.getLastSnapshotLine('s')).toBe(0);
  });

  it('setLastSnapshotLine persists the line count', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setLastSnapshotLine('s', 147);
    expect(await sessionsDb.getLastSnapshotLine('s')).toBe(147);
  });

  it('setLastSnapshotLine creates the session row if absent', async () => {
    // Should not throw even if the session does not exist.
    await expect(sessionsDb.setLastSnapshotLine('ghost-session', 55)).resolves.not.toThrow();
    expect(await sessionsDb.getLastSnapshotLine('ghost-session')).toBe(55);
  });

  it('successive calls advance the cursor monotonically', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setLastSnapshotLine('s', 100);
    expect(await sessionsDb.getLastSnapshotLine('s')).toBe(100);
    await sessionsDb.setLastSnapshotLine('s', 250);
    expect(await sessionsDb.getLastSnapshotLine('s')).toBe(250);
    await sessionsDb.setLastSnapshotLine('s', 410);
    expect(await sessionsDb.getLastSnapshotLine('s')).toBe(410);
  });

  it('cursor is independent per session', async () => {
    await sessionsDb.setLastSnapshotLine('session-a', 100);
    await sessionsDb.setLastSnapshotLine('session-b', 200);
    expect(await sessionsDb.getLastSnapshotLine('session-a')).toBe(100);
    expect(await sessionsDb.getLastSnapshotLine('session-b')).toBe(200);
  });

  // ── Snapshot rate-limit timestamp ────────────────────────────────────────────

  it('getLastSnapshotAt returns null for new sessions', async () => {
    expect(await sessionsDb.getLastSnapshotAt('never-snapshotted')).toBeNull();
  });

  it('setLastSnapshotAt persists wall-clock timestamp', async () => {
    const ts = new Date('2026-05-04T12:00:00.000Z');
    await sessionsDb.setLastSnapshotAt('s', ts);
    expect((await sessionsDb.getLastSnapshotAt('s'))?.toISOString()).toBe(ts.toISOString());
  });

  it('setLastSnapshotAt creates the session row if absent', async () => {
    await expect(sessionsDb.setLastSnapshotAt('ghost')).resolves.not.toThrow();
    expect(await sessionsDb.getLastSnapshotAt('ghost')).toBeInstanceOf(Date);
  });

  it('default (no arg) stamps current time', async () => {
    const before = Date.now();
    await sessionsDb.setLastSnapshotAt('s');
    const after = Date.now();
    const stamped = (await sessionsDb.getLastSnapshotAt('s'))!.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('delta slice produces non-overlapping content across two snapshots', async () => {
    // Simulate the slicing logic from snapshot.ts directly.
    // allLines represents a growing JSONL file.
    const allLinesAtSnap1 = ['line-0', 'line-1', 'line-2', 'line-3', 'line-4'];
    const allLinesAtSnap2 = [...allLinesAtSnap1, 'line-5', 'line-6', 'line-7'];

    // Snapshot 1: cursor starts at 0 → stores all lines.
    await sessionsDb.createSession({ sessionId: 's' });
    const cursor0 = await sessionsDb.getLastSnapshotLine('s');
    const delta1 = allLinesAtSnap1.slice(cursor0);
    await sessionsDb.setLastSnapshotLine('s', allLinesAtSnap1.length);

    // Snapshot 2: cursor advanced to 5 → stores only new lines.
    const cursor1 = await sessionsDb.getLastSnapshotLine('s');
    const delta2 = allLinesAtSnap2.slice(cursor1);
    await sessionsDb.setLastSnapshotLine('s', allLinesAtSnap2.length);

    expect(delta1).toEqual(allLinesAtSnap1);          // first snapshot = full history
    expect(delta2).toEqual(['line-5', 'line-6', 'line-7']); // second = only new lines
    // No overlap.
    const overlap = delta1.filter(l => delta2.includes(l));
    expect(overlap).toHaveLength(0);
  });
});
