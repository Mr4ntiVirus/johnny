// Phase E — rank-refresher integration tests. Drives refresh() against a
// seeded graph and asserts on the SQLite side effects.
//
// Critical invariant under test: edge prunes must hit SQLite via deleteEdge,
// NOT just mutate the in-memory graph (writeGraph only persists rank).
// Pre-fix, prunes vanished on the next readGraph().
import { describe, it, expect, beforeEach } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { addMemory } from '../../src/store/memory.js';
import { readGraph } from '../../src/store/graph.js';
import { reinforceEdge, getEdge, invalidateEdge } from '../../src/store/db/edges.js';
import { setState, setRankUpdatedTurn } from '../../src/store/db/state.js';
import { refresh } from '../../src/daemon/rank-refresher.js';

describe('rank-refresher refresh()', () => {
  useTestDb();

  it('runs without error on an empty graph', async () => {
    await expect(refresh()).resolves.toBeUndefined();
  });

  it('skips when staleTurns is below the refresh threshold', async () => {
    // The refresh-trigger is `currentTurn - graph.rankUpdatedAtTurn >= rankRefreshEveryTurns`.
    // Default rankRefreshEveryTurns = 10. We set both to the same turn → stale=0 → skip.
    const m = await addMemory('mem-x', 'X', 'sum', 'transcript', '/tmp', 100, ['x'], 5);
    await setRankUpdatedTurn(5);
    await setState('turn_counter', '5');
    // No turn advancement → no refresh, rank stays at default 0.15.
    await refresh();
    const graph = await readGraph();
    expect(graph.memories[m.id].rank).toBeCloseTo(0.15, 2);
  });

  it('persists pruned edges to SQLite (regression: writeGraph only persists rank)', async () => {
    // Seed two memories, an edge between them. Make the edge dormant by NOT
    // reinforcing it for many turns, with low weight so lift+trust are floor-low.
    const a = await addMemory('a', 'A', 'sa', 'ta', '/tmp', 50, ['x'], 0);
    const b = await addMemory('b', 'B', 'sb', 'tb', '/tmp', 50, ['y'], 0);
    // Edge with tiny weight + one invalidation drives lift and trust below floors.
    // lift = 0.01/sqrt(1*1) = 0.01 < pruneLiftFloor (0.05).
    // trust = 0.01/(0.01 + 1*2) ≈ 0.005 < pruneTrustFloor (0.1).
    await reinforceEdge(a.id, b.id, 0.01, 0);
    await invalidateEdge(a.id, b.id, 0);

    // Sanity: edge exists in SQLite pre-prune.
    expect(await getEdge(a.id, b.id)).not.toBeNull();

    // Advance the graph rank-stamp (so refresh fires) and the global turn way
    // past the dormancy floor (default 2000 turns).
    await setRankUpdatedTurn(0);
    await setState('turn_counter', '20000');

    await refresh();

    // The edge should be GONE from SQLite — not just from the in-memory graph.
    expect(await getEdge(a.id, b.id)).toBeNull();

    // And readGraph() reflects the prune (proves the deleteEdge actually flushed).
    const graph = await readGraph();
    expect(graph.memories[a.id].outgoingEdges[b.id]).toBeUndefined();
  });

  it('prunes a dormant low-lift/low-trust edge at turn=2500 (was unreachable at old pruneDormancyTurns=10000)', async () => {
    const a = await addMemory('a3', 'A', 'sa', 'ta', '/tmp', 50, ['x'], 0);
    const b = await addMemory('b3', 'B', 'sb', 'tb', '/tmp', 50, ['y'], 0);
    await reinforceEdge(a.id, b.id, 0.01, 0);
    await invalidateEdge(a.id, b.id, 0);
    expect(await getEdge(a.id, b.id)).not.toBeNull();
    await setRankUpdatedTurn(0);
    await setState('turn_counter', '2500');
    await refresh();
    expect(await getEdge(a.id, b.id)).toBeNull();
  });

  it('updates PageRank on memories when refresh fires', async () => {
    const a = await addMemory('a2', 'A', 'sa', 'ta', '/tmp', 50, ['x'], 0);
    const b = await addMemory('b2', 'B', 'sb', 'tb', '/tmp', 50, ['y'], 0);
    await reinforceEdge(a.id, b.id, 1.0, 1);

    await setRankUpdatedTurn(0);
    await setState('turn_counter', '50');

    await refresh();

    // After PageRank, both memories must have ranks; the target of an edge
    // (b) typically gets a higher share than the source under our 0.85 damping.
    const graph = await readGraph();
    expect(graph.memories[a.id].rank).toBeGreaterThan(0);
    expect(graph.memories[b.id].rank).toBeGreaterThan(0);
  });
});
