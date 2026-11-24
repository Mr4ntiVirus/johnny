// Duplicate purge engine, exercised on an in-memory SQLite DB (local-store path).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setDatabasePath, closeDatabase } from '../../src/store/database.js';
import { useTestDb } from '../helpers/db.js';
import { query, execute } from '../../src/store/db-client.js';
import { bulkUpdateMemoryRanks } from '../../src/store/db/memories.js';
import {
  backfillHashes, planDedupe, applyDedupe, verifyDedupe, checkInvariants, purgeMemories, sweepDuplicateChunks,
} from '../../src/maintenance/dedupe.js';

process.env.JOHNNY_LOCAL_STORE = '1';

let seq = 0;
async function mem(id: string, createdAt: string): Promise<void> {
  await execute(
    `INSERT INTO memories (id, snapshot_name, title, summary, created_at) VALUES (?, ?, ?, 'same summary', ?)`,
    [id, `snap-${id}`, id, createdAt]);
  await execute(`INSERT INTO transcripts (memory_id, transcript) VALUES (?, ?)`, [id, `transcript of ${id}`]);
}
async function chunk(memId: string, idx: number, text: string): Promise<void> {
  await execute(
    `INSERT INTO chunks (chunk_id, memory_id, chunk_index, text, created_at) VALUES (?, ?, ?, ?, ?)`,
    [`${memId}#${idx}#${seq++}`, memId, idx, text, '2026-01-01T00:00:00Z']);
}
async function edge(s: string, t: string, w: number, type = 'co_retrieval'): Promise<void> {
  await execute(
    `INSERT INTO edges (source_id, target_id, weight, co_retrieval_count, edge_type, created_at) VALUES (?, ?, ?, 1, ?, '2026-01-01T00:00:00Z')`,
    [s, t, w, type]);
}

describe('dedupe', () => {
  beforeEach(async () => {
    closeDatabase();
    setDatabasePath(':memory:');
    process.env.JOHNNY_LOCAL_STORE = '1';
    seq = 0;
    // A is oldest and owns the canonical copies.
    await mem('A', '2026-01-01T00:00:00Z');
    await mem('B', '2026-02-01T00:00:00Z'); // pure clone of A
    await mem('C', '2026-03-01T00:00:00Z'); // clone of A + one unique chunk
    await mem('D', '2026-04-01T00:00:00Z'); // unrelated
    await chunk('A', 0, 'alpha   text');
    await chunk('A', 1, 'beta text');
    await chunk('B', 0, 'alpha text');   // whitespace-only difference => duplicate
    await chunk('B', 1, 'beta text');
    await chunk('C', 0, 'alpha text');
    await chunk('C', 1, 'unique to C');
    await chunk('D', 0, 'delta text');
  });

  afterAll(() => closeDatabase());

  it('backfills hashes then plans canonical = earliest memory', async () => {
    expect(await backfillHashes()).toBe(7);
    expect(await backfillHashes()).toBe(0); // idempotent
    const plan = await planDedupe();
    expect(plan.totalChunks).toBe(7);
    expect(plan.distinctHashes).toBe(4);
    expect(plan.duplicateChunkIds).toHaveLength(3); // B0, B1, C0
    expect(plan.purge).toEqual({ B: 'A' });         // only B had nothing of its own
    expect(plan.keptMemories).toBe(3);              // A, C, D keep chunks
  });

  it('apply removes duplicate chunks and purges emptied memories, merging edges into the canonical', async () => {
    await edge('B', 'D', 0.8);
    await edge('D', 'B', 0.6);
    await edge('A', 'D', 0.3);   // existing edge: merge must keep max weight, sum counts
    await edge('B', 'A', 0.9);   // becomes a self-loop after merge: dropped
    await edge('C', 'D', 0.5);   // untouched

    await backfillHashes();
    const plan = await planDedupe();
    const res = await applyDedupe(plan);
    expect(res).toMatchObject({ deletedChunks: 3, purgedMemories: 1, droppedEdges: 1 });

    const mems = await query<{ id: string }>('SELECT id FROM memories ORDER BY id');
    expect(mems.map(m => m.id)).toEqual(['A', 'C', 'D']);

    const ad = (await query<{ weight: number; co_retrieval_count: number }>(
      `SELECT weight, co_retrieval_count FROM edges WHERE source_id='A' AND target_id='D'`))[0];
    expect(ad.weight).toBeCloseTo(0.8, 6);          // max(0.3, 0.8 from B→D)
    expect(ad.co_retrieval_count).toBe(2);           // 1 + 1
    const da = (await query<{ weight: number }>(`SELECT weight FROM edges WHERE source_id='D' AND target_id='A'`))[0];
    expect(da.weight).toBeCloseTo(0.6, 6);           // D→B re-pointed to D→A
    expect(await query(`SELECT 1 FROM edges WHERE source_id='A' AND target_id='A'`)).toHaveLength(0);
    expect(await query(`SELECT 1 FROM edges WHERE source_id='C' AND target_id='D'`)).toHaveLength(1);

    const v = await verifyDedupe();
    expect(checkInvariants(v)).toEqual([]);
    expect(v.chunks).toBe(4);
    expect(v.distinctChunkTexts).toBe(4);
    // Transcript of the purged memory went with it; kept memories keep theirs.
    expect(await query(`SELECT 1 FROM transcripts WHERE memory_id='B'`)).toHaveLength(0);
    expect(await query(`SELECT 1 FROM transcripts WHERE memory_id='C'`)).toHaveLength(1);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    await backfillHashes();
    await applyDedupe(await planDedupe());
    const again = await planDedupe();
    expect(again.duplicateChunkIds).toHaveLength(0);
    expect(Object.keys(again.purge)).toHaveLength(0);
    expect(await applyDedupe(again)).toMatchObject({ deletedChunks: 0, purgedMemories: 0 });
  });

  it('clears session references to purged memories (FK + JSON arrays)', async () => {
    await execute(`INSERT INTO sessions (session_id, active_memory_id, surfaced_memories, recalled_memory_ids) VALUES ('s1', 'B', ?, ?)`,
      [JSON.stringify({ B: 3, D: 5 }), JSON.stringify(['B', 'A'])]);
    await backfillHashes();
    await applyDedupe(await planDedupe()); // would throw an FK error if active_memory_id weren't cleared
    const s = (await query<{ active_memory_id: string | null; surfaced_memories: string; recalled_memory_ids: string }>(
      `SELECT active_memory_id, surfaced_memories, recalled_memory_ids FROM sessions WHERE session_id='s1'`))[0];
    expect(s.active_memory_id).toBeNull();
    expect(JSON.parse(s.surfaced_memories)).toEqual({ D: 5 });
    expect(JSON.parse(s.recalled_memory_ids)).toEqual(['A']);
  });

  it('bulkUpdateMemoryRanks works on SQLite (it used a Postgres-only unnest() and broke the post-purge rank recompute)', async () => {
    await bulkUpdateMemoryRanks([{ id: 'A', rank: 0.9, turn: 1 }, { id: 'D', rank: 0.4, turn: 1 }]);
    const rows = await query<{ id: string; rank: number }>(`SELECT id, rank FROM memories WHERE id IN ('A','D') ORDER BY id`);
    expect(rows.map(r => [r.id, Number(r.rank)])).toEqual([['A', 0.9], ['D', 0.4]]);
    await bulkUpdateMemoryRanks([]); // no-op
  });

  it('standing sweep deletes straggler duplicate chunk ROWS only — never memories', async () => {
    const r = await sweepDuplicateChunks();
    expect(r.hashed).toBe(7);
    expect(r.deleted).toBe(3);
    expect((await query('SELECT id FROM memories'))).toHaveLength(4); // B survives as a (chunkless) memory shell
    expect((await verifyDedupe()).chunks).toBe(4);
    expect(await sweepDuplicateChunks()).toEqual({ hashed: 0, deleted: 0 }); // idempotent
  });

  it('purgeMemories merges derived_from precedence and keeps the heavier weight', async () => {
    await edge('B', 'D', 0.4, 'derived_from');
    await edge('A', 'D', 0.7, 'co_retrieval');
    const r = await purgeMemories({ B: 'A' });
    expect(r.mergedEdges).toBe(1);
    const e = (await query<{ weight: number; edge_type: string }>(`SELECT weight, edge_type FROM edges WHERE source_id='A' AND target_id='D'`))[0];
    expect(e.weight).toBeCloseTo(0.7, 6);
    expect(e.edge_type).toBe('derived_from');
  });

  it('mapping resolves chains (canonical purged elsewhere) without creating orphans', async () => {
    await edge('B', 'D', 0.5);
    await purgeMemories({ B: 'C', C: 'A' }); // B→C→A
    const ids = (await query<{ id: string }>('SELECT id FROM memories ORDER BY id')).map(r => r.id);
    expect(ids).toEqual(['A', 'D']);
    expect(await query(`SELECT 1 FROM edges WHERE source_id='A' AND target_id='D'`)).toHaveLength(1);
    expect((await verifyDedupe()).orphanEdges).toBe(0);
  });
});


// Same SQL, Postgres dialect (the daemon / ECS side purges from the id mapping
// the local run produced). Runs against the johnny_test database.
describe('dedupe on Postgres', () => {
  useTestDb();

  async function pgMem(id: string): Promise<void> {
    await execute(`INSERT INTO memories (id, snapshot_name, title, created_at) VALUES (?, ?, ?, ?)`,
      [id, `snap-${id}`, id, '2026-01-01T00:00:00Z']);
  }
  async function pgEdge(s: string, t: string, w: number, type = 'co_retrieval'): Promise<void> {
    await execute(
      `INSERT INTO edges (source_id, target_id, weight, co_retrieval_count, edge_type, created_at) VALUES (?, ?, ?, 1, ?, '2026-01-01T00:00:00Z')`,
      [s, t, w, type]);
  }

  it('purgeMemories merges edges (max weight, summed counts, derived_from wins) and deletes via cascade', async () => {
    delete process.env.JOHNNY_LOCAL_STORE;
    for (const id of ['A', 'B', 'D']) await pgMem(id);
    await pgEdge('B', 'D', 0.4, 'derived_from');
    await pgEdge('A', 'D', 0.7);
    await pgEdge('B', 'A', 0.9); // self-loop after merge
    await execute(`INSERT INTO chunks (chunk_id, memory_id, chunk_index, text, created_at) VALUES ('B#0','B',0,'x','2026-01-01')`);
    await execute(`INSERT INTO sessions (session_id, active_memory_id) VALUES ('s','B')`);

    const r = await purgeMemories({ B: 'A' });
    expect(r).toMatchObject({ purgedMemories: 1, mergedEdges: 1, droppedEdges: 1 });

    const e = (await query<{ weight: number; edge_type: string; co_retrieval_count: number }>(
      `SELECT weight, edge_type, co_retrieval_count FROM edges WHERE source_id='A' AND target_id='D'`))[0];
    expect(e.weight).toBeCloseTo(0.7, 6);
    expect(e.edge_type).toBe('derived_from');
    expect(e.co_retrieval_count).toBe(2);
    expect(await query(`SELECT 1 FROM chunks WHERE memory_id='B'`)).toHaveLength(0);
    expect((await query<{ active_memory_id: string | null }>(`SELECT active_memory_id FROM sessions WHERE session_id='s'`))[0].active_memory_id).toBeNull();
    expect(checkInvariants(await verifyDedupe())).toEqual([]);
  });
});
