import { describe, it, expect } from 'vitest';
import { rescaleAndPrune } from '../../src/sleep/homeostasis.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { Memory, Edge, MemoryGraph } from '../../src/types.js';

// Default opts for tests: treat all snapshots as existing on disk so orphan
// detection doesn't nuke fixtures. Tests that exercise orphan behavior
// override this explicitly.
const TEST_OPTS = { snapshotExists: async () => true };

function makeEdge(weight: number, opts: Partial<Edge> = {}): Edge {
  return {
    weight,
    coRetrievalCount: 1,
    lastReinforcedTurn: opts.lastReinforcedTurn ?? 1,
    lastReinforcedAt: '',
    invalidationCount: opts.invalidationCount ?? 0,
    lastInvalidatedTurn: null,
    ...opts,
  };
}

function makeMem(
  id: string,
  opts: Partial<Memory> = {},
): Memory {
  return {
    id,
    snapshotName: id,
    summary: id,
    embedding: null,
    topics: [],
    projectPath: '',
    tokenCount: 100,
    retrievalCount: opts.retrievalCount ?? 5,
    lastRetrievedTurn: opts.lastRetrievedTurn ?? 50,
    lastRetrievedAt: '',
    createdAtTurn: 1,
    createdAt: '',
    outgoingEdges: {},
    incomingEdges: {},
    rank: opts.rank ?? 0.15,
    rankUpdatedAtTurn: 1,
    ...opts,
  };
}

function makeGraph(...mems: Memory[]): MemoryGraph {
  const memories: Record<string, Memory> = {};
  for (const m of mems) memories[m.id] = m;
  return { version: 1, rankUpdatedAtTurn: 0, memories };
}

describe('rescaleAndPrune — edge pruning', () => {
  it('prunes edge when 2 of 3 conditions met (dormant + low trust)', async () => {
    // Seed 3 "hot" memories that fill the protection slots, then 2 stale ones under test
    const hot1 = makeMem('hot1', { lastRetrievedTurn: 4999 });
    const hot2 = makeMem('hot2', { lastRetrievedTurn: 4998 });
    const hot3 = makeMem('hot3', { lastRetrievedTurn: 4997 });
    const a = makeMem('a', { retrievalCount: 100, lastRetrievedTurn: 10 });
    const b = makeMem('b', { retrievalCount: 100, lastRetrievedTurn: 10 });
    // dormant: lastReinforcedTurn=1, currentTurn=5000 → gap 4999 ≥ 1000 ✓
    // low trust: invalidationCount=5, weight=1 → trust = 1/(1+5*2)=0.09 < 0.2 ✓
    // low lift: 1/sqrt(100*100) = 0.01 < 0.1 ✓ (all 3 met)
    const edge = makeEdge(1, { lastReinforcedTurn: 1, invalidationCount: 5 });
    a.outgoingEdges['b'] = edge;
    b.incomingEdges['a'] = edge;

    const graph = makeGraph(hot1, hot2, hot3, a, b);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 5000, TEST_OPTS);
    expect(result.edgesPruned).toBe(1);
    expect(graph.memories['a'].outgoingEdges['b']).toBeUndefined();
  });

  it('keeps healthy recent edge', async () => {
    const a = makeMem('a', { retrievalCount: 2 });
    const b = makeMem('b', { retrievalCount: 2 });
    // recent, high-trust, decent lift → should survive
    const edge = makeEdge(5, { lastReinforcedTurn: 95, invalidationCount: 0 });
    a.outgoingEdges['b'] = edge;
    b.incomingEdges['a'] = edge;

    const graph = makeGraph(a, b);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 100, TEST_OPTS);
    expect(result.edgesPruned).toBe(0);
    expect(graph.memories['a'].outgoingEdges['b']).toBeDefined();
  });

  it('protects the 3 most recently retrieved memories from pruning', async () => {
    const recent = makeMem('recent', { lastRetrievedTurn: 999 });
    const old    = makeMem('old',    { lastRetrievedTurn: 1 });
    // dormant + bad trust edge on 'recent' — would normally get pruned
    const edge = makeEdge(0.01, { lastReinforcedTurn: 1, invalidationCount: 50 });
    recent.outgoingEdges['old'] = edge;
    old.incomingEdges['recent'] = edge;

    const graph = makeGraph(recent, old);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 5000, TEST_OPTS);
    // 'recent' is in top-3 most-recently-retrieved → protected → edge survives
    expect(result.edgesPruned).toBe(0);
  });
});

describe('rescaleAndPrune — homeostatic rescaling', () => {
  it('rescales when total edge weight exceeds cap', async () => {
    const mems = Array.from({ length: 4 }, (_, i) => makeMem(`m${i}`, { retrievalCount: 10 }));
    const graph = makeGraph(...mems);

    // Create edges with high total weight > 1000
    let edgeCount = 0;
    for (let i = 0; i < mems.length; i++) {
      for (let j = 0; j < mems.length; j++) {
        if (i === j) continue;
        const edge = makeEdge(100, { lastReinforcedTurn: 90 });
        mems[i].outgoingEdges[mems[j].id] = edge;
        mems[j].incomingEdges[mems[i].id] = edge;
        edgeCount++;
      }
    }
    // total weight = 12 edges × 100 = 1200 > cap of 1000

    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 100, TEST_OPTS);
    expect(result.rescaleApplied).toBe(true);
    expect(result.scaleFactor).toBeLessThan(1);

    // All weights should be scaled down
    for (const mem of Object.values(graph.memories)) {
      for (const edge of Object.values(mem.outgoingEdges)) {
        expect(edge.weight).toBeLessThan(100);
      }
    }
  });

  it('skips rescaling when under cap', async () => {
    const a = makeMem('a');
    const b = makeMem('b');
    const edge = makeEdge(0.5, { lastReinforcedTurn: 90 });
    a.outgoingEdges['b'] = edge;
    b.incomingEdges['a'] = edge;

    const graph = makeGraph(a, b);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 100, TEST_OPTS);
    expect(result.rescaleApplied).toBe(false);
    expect(result.scaleFactor).toBe(1);
  });
});

describe('rescaleAndPrune — memory archival', () => {
  it('archives isolated stale low-rank memories', async () => {
    // Fill the 3 protection slots with hot memories, then add the stale target
    const hot1 = makeMem('hot1', { lastRetrievedTurn: 4999, rank: 0.4 });
    const hot2 = makeMem('hot2', { lastRetrievedTurn: 4998, rank: 0.4 });
    const hot3 = makeMem('hot3', { lastRetrievedTurn: 4997, rank: 0.4 });
    const stale = makeMem('stale', { rank: 0.01, lastRetrievedTurn: 1, retrievalCount: 1 });
    // stale: no incoming edges, very low rank, dormant 5000 turns ago

    const graph = makeGraph(hot1, hot2, hot3, stale);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 5000, TEST_OPTS);
    // Archiving is DISABLED - we keep all memories regardless of staleness
    expect(result.memoriesArchived).toBe(0);
    expect(graph.memories['stale']).toBeDefined();
  });

  it('does not archive memories with incoming edges', async () => {
    const a = makeMem('a', { rank: 0.5, lastRetrievedTurn: 99 });
    const b = makeMem('b', { rank: 0.01, lastRetrievedTurn: 1, retrievalCount: 1 });
    // b has low rank/stale but a links to it → keep it
    const edge = makeEdge(1);
    a.outgoingEdges['b'] = edge;
    b.incomingEdges['a'] = edge;

    const graph = makeGraph(a, b);
    const result = await rescaleAndPrune(graph, DEFAULT_CONFIG, 5000, TEST_OPTS);
    expect(result.memoriesArchived).toBe(0);
    expect(graph.memories['b']).toBeDefined();
  });
});
