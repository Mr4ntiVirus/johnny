import { describe, it, expect } from 'vitest';
import {
  computeLift, computeTrust, computeEffectiveWeight,
  computeActivation, phase1Score, recomputePageRank,
} from '../../src/store/graph.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { Memory, Edge, MemoryGraph } from '../../src/types.js';

function makeEdge(weight: number, invalidations = 0): Edge {
  return {
    weight, coRetrievalCount: weight, invalidationCount: invalidations,
    lastReinforcedTurn: 1, lastReinforcedAt: '', lastInvalidatedTurn: null,
  };
}

function makeMem(id: string, retrievalCount = 10, lastRetrievedTurn = 50): Memory {
  return {
    id, snapshotName: id, summary: id, embedding: null, topics: [],
    projectPath: '', tokenCount: 100,
    retrievalCount, lastRetrievedTurn, lastRetrievedAt: '',
    createdAtTurn: 1, createdAt: '',
    outgoingEdges: {}, incomingEdges: {},
    rank: 0.15, rankUpdatedAtTurn: 1,
  };
}

describe('computeLift', () => {
  it('is proportional to shared co-retrieval', () => {
    const a = makeMem('a', 4);
    const b = makeMem('b', 4);
    const edge = makeEdge(2);
    expect(computeLift(edge, a, b)).toBeCloseTo(2 / 4, 3);
  });

  it('dilutes when one memory has far more retrievals', () => {
    const a = makeMem('a', 1);
    const b = makeMem('b', 1000);
    const edge = makeEdge(1);
    expect(computeLift(edge, a, b)).toBeLessThan(0.1);
  });
});

describe('computeTrust', () => {
  it('is 1 with no invalidations', () => {
    const edge = makeEdge(5, 0);
    expect(computeTrust(edge, 2.0)).toBe(1);
  });

  it('drops with invalidations', () => {
    const edge = makeEdge(2, 1);  // 1 invalidation, λ=2: trust = 2/(2+2) = 0.5
    expect(computeTrust(edge, 2.0)).toBeCloseTo(0.5, 3);
  });
});

describe('computeActivation', () => {
  it('is 1 for never-retrieved memory', () => {
    const m = makeMem('a', 0, 0);
    expect(computeActivation(m, 100, 500)).toBe(1.0);
  });

  it('decays with turns since last retrieval', () => {
    const m = makeMem('a', 5, 1);
    const active = computeActivation(m, 2, 500);    // 1 turn ago
    const dormant = computeActivation(m, 501, 500); // 500 turns ago
    expect(active).toBeGreaterThan(dormant);
    expect(dormant).toBeCloseTo(Math.exp(-1), 3);
  });
});

describe('recomputePageRank', () => {
  it('distributes rank across linked memories', () => {
    const a = makeMem('a');
    const b = makeMem('b');
    const edge = makeEdge(1);
    a.outgoingEdges['b'] = edge;
    b.incomingEdges['a'] = edge;

    const graph: MemoryGraph = { version: 1, memories: { a, b } };
    recomputePageRank(graph, DEFAULT_CONFIG, 100);

    // b receives rank from a, so b.rank should be higher than a.rank
    expect(graph.memories['b'].rank).toBeGreaterThan(graph.memories['a'].rank);
  });

  it('isolated memory gets baseline rank', () => {
    const a = makeMem('a');
    const graph: MemoryGraph = { version: 1, memories: { a } };
    recomputePageRank(graph, DEFAULT_CONFIG, 100);
    expect(graph.memories['a'].rank).toBeGreaterThan(0);
  });
});
