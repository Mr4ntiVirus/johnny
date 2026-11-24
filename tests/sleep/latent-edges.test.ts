import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { discoverLatentEdges } from '../../src/sleep/latent-edges.js';
import * as edgesDb from '../../src/store/db/edges.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { Memory, MemoryGraph } from '../../src/types.js';

// Uses JOHNNY_LLM_MOCK — mockEmbedding() produces deterministic vectors.
// Identical strings → identical vectors → cosine = 1.0 (perfect similarity).
// Different strings → different vectors with lower similarity.

function makeMem(id: string, embedding: number[] | null, topics: string[]): Memory {
  return {
    id, snapshotName: id, summary: id, embedding,
    topics, projectPath: '', tokenCount: 100,
    retrievalCount: 0, lastRetrievedTurn: 0, lastRetrievedAt: '',
    createdAtTurn: 1, createdAt: '',
    outgoingEdges: {}, incomingEdges: {},
    rank: 0.15, rankUpdatedAtTurn: 1,
  };
}

function makeGraph(...mems: Memory[]): MemoryGraph {
  const memories: Record<string, Memory> = {};
  for (const m of mems) memories[m.id] = m;
  return { version: 1, rankUpdatedAtTurn: 0, memories };
}

// Produce a unit vector from a seed number (deterministic, high cosine with same seed)
function seedVec(seed: number, dim = 64): number[] {
  const vec = new Array<number>(dim).fill(0).map((_, i) => Math.sin(seed + i * 0.1));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

describe('discoverLatentEdges', () => {
  it('adds edges between high-cosine similar memories with topic overlap', async () => {
    // Use nearly-identical vectors (cosine ≈ 1.0) with shared topics
    const embed = seedVec(1);
    const a = makeMem('a', embed, ['roku', 'auth', 'api']);
    const b = makeMem('b', embed, ['roku', 'auth', 'fix']);  // shared: roku, auth
    const graph = makeGraph(a, b);

    const result = await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    expect(result.latentEdgesAdded).toBeGreaterThan(0);
    // Both directions should be added
    expect(graph.memories['a'].outgoingEdges['b']).toBeDefined();
    expect(graph.memories['b'].outgoingEdges['a']).toBeDefined();
  });

  it('skips pairs with no topic overlap even if embeddings are similar', async () => {
    const embed = seedVec(1);
    const a = makeMem('a', embed, ['roku', 'auth']);
    const b = makeMem('b', embed, ['docker', 'nginx']);  // no shared topics
    const graph = makeGraph(a, b);

    const result = await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    expect(result.latentEdgesAdded).toBe(0);
  });

  it('skips memories without embeddings', async () => {
    const a = makeMem('a', null, ['roku', 'auth']);
    const b = makeMem('b', null, ['roku', 'auth']);
    const graph = makeGraph(a, b);

    const result = await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    expect(result.latentEdgesAdded).toBe(0);
  });

  it('skips pairs that already have an edge', async () => {
    const embed = seedVec(1);
    const a = makeMem('a', embed, ['roku', 'auth']);
    const b = makeMem('b', embed, ['roku', 'auth']);
    // Pre-existing edge a → b
    const existing = {
      weight: 1, coRetrievalCount: 1, lastReinforcedTurn: 1, lastReinforcedAt: '',
      invalidationCount: 0, lastInvalidatedTurn: null,
    };
    a.outgoingEdges['b'] = existing;
    b.incomingEdges['a'] = existing;

    const graph = makeGraph(a, b);
    const result = await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    // a→b already exists; b→a doesn't → only b→a added
    expect(graph.memories['a'].outgoingEdges['b']).toBe(existing); // unchanged
  });

  it('latent edge weight is weaker than Hebbian reinforcement delta', async () => {
    const embed = seedVec(1);
    const a = makeMem('a', embed, ['roku', 'auth']);
    const b = makeMem('b', embed, ['roku', 'auth']);
    const graph = makeGraph(a, b);

    await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    const edge = graph.memories['a'].outgoingEdges['b'];
    if (edge) {
      expect(edge.weight).toBeLessThan(DEFAULT_CONFIG.reinforcementDelta);
    }
  });

  it('returns 0 for single memory graph', async () => {
    const a = makeMem('a', seedVec(1), ['roku']);
    const graph = makeGraph(a);
    const result = await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    expect(result.latentEdgesAdded).toBe(0);
  });
});

describe('discoverLatentEdges — DB persistence', () => {
  useTestDb();

  async function seedDbMem(id: string): Promise<Memory> {
    await memoriesDb.createMemory({ id, snapshotName: id, title: id, tokenCount: 10 });
    return makeMem(id, seedVec(42), ['shared-topic', 'auth']);
  }

  it('persists latent edges to DB with edge_type semantic_similarity', async () => {
    const a = await seedDbMem('db-a');
    const b = await seedDbMem('db-b');
    const graph = makeGraph(a, b);

    await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);

    const ab = await edgesDb.getEdge('db-a', 'db-b');
    const ba = await edgesDb.getEdge('db-b', 'db-a');
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab!.edge_type).toBe('semantic_similarity');
    expect(ab!.weight).toBeCloseTo(0.3);
  });

  it('persists both directions', async () => {
    const a = await seedDbMem('dir-a');
    const b = await seedDbMem('dir-b');
    const graph = makeGraph(a, b);

    await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);

    expect(await edgesDb.getEdge('dir-a', 'dir-b')).not.toBeNull();
    expect(await edgesDb.getEdge('dir-b', 'dir-a')).not.toBeNull();
  });

  it('does not throw on second call — UNIQUE constraint swallowed', async () => {
    const a = await seedDbMem('idem-a');
    const b = await seedDbMem('idem-b');
    const graph = makeGraph(a, b);

    await discoverLatentEdges(graph, DEFAULT_CONFIG, 100);
    await expect(discoverLatentEdges(graph, DEFAULT_CONFIG, 101)).resolves.not.toThrow();
  });
});
