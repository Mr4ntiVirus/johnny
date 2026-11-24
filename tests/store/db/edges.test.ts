import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as memoriesDb from '../../../src/store/db/memories.js';
import * as edgesDb from '../../../src/store/db/edges.js';

async function seedMemory(slug: string): Promise<string> {
  return memoriesDb.createMemory({
    snapshotName: slug,
    title: slug,
    summary: slug,
    contentType: 'text',
    projectPath: '/tmp',
    tokenCount: 10,
    createdAtTurn: 1,
  });
}

describe('db/edges.ts', () => {
  useTestDb();

  it('createEdge inserts a row with defaults', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.createEdge({ sourceId: a, targetId: b, createdAtTurn: 1 });

    const edge = await edgesDb.getEdge(a, b);
    expect(edge).not.toBeNull();
    expect(edge?.weight).toBeCloseTo(0.15);
    expect(edge?.co_retrieval_count).toBe(0);
    expect(edge?.invalidation_count).toBe(0);
  });

  it('edges FK enforces referential integrity', async () => {
    const a = await seedMemory('a');
    await expect(
      edgesDb.createEdge({ sourceId: a, targetId: 'ghost', createdAtTurn: 1 }),
    ).rejects.toThrow();
  });

  it('deleting a memory cascades to its edges', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.createEdge({ sourceId: a, targetId: b, createdAtTurn: 1 });
    await memoriesDb.deleteMemory(a);
    expect(await edgesDb.getEdge(a, b)).toBeNull();
  });

  it('reinforceEdge creates then increments', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.reinforceEdge(a, b, 0.2, 5);
    let e = await edgesDb.getEdge(a, b);
    expect(e?.weight).toBeCloseTo(0.2);
    expect(e?.co_retrieval_count).toBe(1);
    expect(e?.last_reinforced_turn).toBe(5);

    await edgesDb.reinforceEdge(a, b, 0.3, 7);
    e = await edgesDb.getEdge(a, b);
    expect(e?.weight).toBeCloseTo(0.5);
    expect(e?.co_retrieval_count).toBe(2);
    expect(e?.last_reinforced_turn).toBe(7);
  });

  it('invalidateEdge increments invalidation_count', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.invalidateEdge(a, b, 8);
    const e = await edgesDb.getEdge(a, b);
    expect(e?.invalidation_count).toBe(1);
    expect(e?.last_invalidated_turn).toBe(8);
  });

  it('getOutgoingEdges / getIncomingEdges filter correctly', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.reinforceEdge(a, c, 0.2, 1);
    await edgesDb.reinforceEdge(c, a, 0.3, 1);

    const out = await edgesDb.getOutgoingEdges(a);
    const bRow = await memoriesDb.getMemoryBySnapshot('b');
    const cRow = await memoriesDb.getMemoryBySnapshot('c');
    expect(out.map(e => e.target_id).sort()).toEqual([bRow!.id, cRow!.id].sort());

    const incoming = await edgesDb.getIncomingEdges(a);
    expect(incoming.length).toBe(1);
    expect(incoming[0].source_id).toBe(c);
  });

  it('getOutgoingEdges sorts by weight desc', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.reinforceEdge(a, c, 0.5, 1);
    const out = await edgesDb.getOutgoingEdges(a);
    expect(out[0].target_id).toBe(c);
    expect(out[1].target_id).toBe(b);
  });

  it('edgeExists reflects presence', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    expect(await edgesDb.edgeExists(a, b)).toBe(false);
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    expect(await edgesDb.edgeExists(a, b)).toBe(true);
  });

  it('UNIQUE(source,target) prevents duplicate createEdge', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.createEdge({ sourceId: a, targetId: b, createdAtTurn: 1 });
    await expect(
      edgesDb.createEdge({ sourceId: a, targetId: b, createdAtTurn: 2 }),
    ).rejects.toThrow();
  });

  it('pruneWeakEdges removes edges under threshold', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.005, 1);
    await edgesDb.reinforceEdge(a, c, 0.2, 1);
    const pruned = await edgesDb.pruneWeakEdges(0.01);
    expect(pruned).toBe(1);
    expect(await edgesDb.edgeExists(a, b)).toBe(false);
    expect(await edgesDb.edgeExists(a, c)).toBe(true);
  });

  it('pruneWeakEdges spares derived_from edges regardless of weight', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    // Two below-threshold edges: one ordinary, one provenance.
    await edgesDb.reinforceEdge(a, b, 0.005, 1);                            // co_retrieval, weak
    await edgesDb.createEdge({ sourceId: a, targetId: c, weight: 0.001, edgeType: 'derived_from' });

    const pruned = await edgesDb.pruneWeakEdges(0.01);

    expect(pruned).toBe(1);
    expect(await edgesDb.edgeExists(a, b)).toBe(false);                     // ordinary edge gone
    expect(await edgesDb.edgeExists(a, c)).toBe(true);                      // lineage preserved
    expect((await edgesDb.getEdge(a, c))?.edge_type).toBe('derived_from');
  });

  it('getTotalEdgeCount reflects inserts and prunes', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    expect(await edgesDb.getTotalEdgeCount()).toBe(0);
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.reinforceEdge(a, c, 0.1, 1);
    expect(await edgesDb.getTotalEdgeCount()).toBe(2);
  });

  it('getConnectedMemories returns neighbors in both directions', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.reinforceEdge(c, a, 0.1, 1);
    const connected = (await edgesDb.getConnectedMemories(a)).sort();
    expect(connected).toEqual([b, c].sort());
  });

  it('getEdgeStats returns totalEdges + avgWeight + weakest', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.2, 1);
    await edgesDb.reinforceEdge(a, c, 0.4, 1);
    const stats = await edgesDb.getEdgeStats();
    expect(stats.totalEdges).toBe(2);
    expect(stats.avgWeight).toBeCloseTo(0.3);
    expect(stats.weakestEdge?.weight).toBeCloseTo(0.2);
  });

  it('updateEdgeWeight sets weight directly', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.updateEdgeWeight(a, b, 0.99);
    expect((await edgesDb.getEdge(a, b))?.weight).toBeCloseTo(0.99);
  });

  it('getTopEdgesByWeight sorts desc with limit', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.reinforceEdge(a, c, 0.5, 1);
    await edgesDb.reinforceEdge(b, c, 0.3, 1);
    const top = await edgesDb.getTopEdgesByWeight(2);
    expect(top.length).toBe(2);
    expect(top[0].weight).toBeCloseTo(0.5);
    expect(top[1].weight).toBeCloseTo(0.3);
  });

  it('deleteEdge removes the row', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await edgesDb.deleteEdge(a, b);
    expect(await edgesDb.getEdge(a, b)).toBeNull();
  });

  it('createEdge defaults edge_type to co_retrieval', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.createEdge({ sourceId: a, targetId: b, createdAtTurn: 1 });
    expect((await edgesDb.getEdge(a, b))?.edge_type).toBe('co_retrieval');
  });

  it('createEdge accepts an explicit edgeType', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await edgesDb.createEdge({ sourceId: a, targetId: b, edgeType: 'derived_from', createdAtTurn: 1 });
    expect((await edgesDb.getEdge(a, b))?.edge_type).toBe('derived_from');
  });

  it('createDerivedFromEdges emits both directions with derived_from + provenance weight', async () => {
    const child = await seedMemory('child');
    const p1 = await seedMemory('parent-one');
    const p2 = await seedMemory('parent-two');

    await edgesDb.createDerivedFromEdges(child, [p1, p2], 42, 1.0, 50);

    for (const parent of [p1, p2]) {
      const out = await edgesDb.getEdge(child, parent);
      const back = await edgesDb.getEdge(parent, child);
      expect(out?.edge_type).toBe('derived_from');
      expect(back?.edge_type).toBe('derived_from');
      expect(out?.weight).toBeCloseTo(1.0);
      expect(back?.weight).toBeCloseTo(1.0);
      expect(out?.created_at_turn).toBe(42);
    }
  });

  it('createDerivedFromEdges promotes existing co_retrieval edges (sticky)', async () => {
    const child = await seedMemory('child');
    const parent = await seedMemory('parent');

    // Pre-existing co_retrieval edge from a prior session — weight 0.5
    await edgesDb.reinforceEdge(child, parent, 0.5, 10);
    expect((await edgesDb.getEdge(child, parent))?.edge_type).toBe('co_retrieval');

    await edgesDb.createDerivedFromEdges(child, [parent], 20, 1.0, 50);

    const promoted = await edgesDb.getEdge(child, parent);
    expect(promoted?.edge_type).toBe('derived_from');
    // MAX(existing, provenance baseline) — preserves Hebbian gain when it
    // exceeds the baseline; promotes when baseline is higher (the usual case).
    expect(promoted?.weight).toBeCloseTo(1.0);
  });

  it('createDerivedFromEdges is a no-op for empty parents', async () => {
    const child = await seedMemory('child');
    await expect(edgesDb.createDerivedFromEdges(child, [], 1, 1.0, 50)).resolves.not.toThrow();
    expect(await edgesDb.getTotalEdgeCount()).toBe(0);
  });

  it('createDerivedFromEdges skips self-references', async () => {
    const child = await seedMemory('child');
    await edgesDb.createDerivedFromEdges(child, [child], 1, 1.0, 50);
    expect(await edgesDb.getTotalEdgeCount()).toBe(0);
  });

  it('createDerivedFromEdges is atomic across parents', async () => {
    const child = await seedMemory('child');
    const p1 = await seedMemory('p1');
    const p2 = await seedMemory('p2');
    await edgesDb.createDerivedFromEdges(child, [p1, p2], 1, 1.0, 50);
    // 2 parents × 2 directions = 4 edges
    expect(await edgesDb.getTotalEdgeCount()).toBe(4);
  });

  it('createDerivedFromEdges caps outgoing edges at topKOutgoing (regression: was unbounded, hubs hit 1000+ edges in production)', async () => {
    const child = await seedMemory('child');
    const parents: string[] = [];
    for (let i = 0; i < 60; i++) parents.push(await seedMemory(`parent-${i}`));

    await edgesDb.createDerivedFromEdges(child, parents, 1, 1.0, 50);

    const childOutgoing = await edgesDb.getOutgoingEdges(child);
    expect(childOutgoing.length).toBeLessThanOrEqual(50);

    // Every parent also gets an outgoing edge back to child (1 each) — well
    // under the cap, so those should all survive untouched.
    const oneParentOutgoing = await edgesDb.getOutgoingEdges(parents[0]);
    expect(oneParentOutgoing.length).toBe(1);
  });
});
