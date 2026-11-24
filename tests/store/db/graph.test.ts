import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as memoriesDb from '../../../src/store/db/memories.js';
import * as edgesDb from '../../../src/store/db/edges.js';
import * as transcriptsDb from '../../../src/store/db/transcripts.js';
import * as graphDb from '../../../src/store/db/graph.js';

async function seedMem(slug: string): Promise<string> {
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

describe('db/graph.ts — loadGraph / saveGraph round-trip', () => {
  useTestDb();

  it('loadGraph on empty DB returns empty memories map', async () => {
    const g = await graphDb.loadGraph();
    expect(Object.keys(g.memories).length).toBe(0);
    expect(g.version).toBe(1);
  });

  it('loadGraph hydrates memories and their edges', async () => {
    const a = await seedMem('a');
    const b = await seedMem('b');
    const c = await seedMem('c');
    await edgesDb.reinforceEdge(a, b, 0.3, 5);
    await edgesDb.reinforceEdge(a, c, 0.1, 5);
    await edgesDb.reinforceEdge(b, a, 0.2, 5);

    const g = await graphDb.loadGraph();
    expect(Object.keys(g.memories).sort()).toEqual([a, b, c].sort());

    const memA = g.memories[a];
    expect(Object.keys(memA.outgoingEdges).sort()).toEqual([b, c].sort());
    expect(memA.outgoingEdges[b].weight).toBeCloseTo(0.3);
    expect(Object.keys(memA.incomingEdges)).toEqual([b]);
    expect(memA.incomingEdges[b].weight).toBeCloseTo(0.2);
  });

  it('saveGraph persists rank changes when rankUpdatedAtTurn > 0', async () => {
    const a = await seedMem('a');
    const g = await graphDb.loadGraph();
    g.memories[a].rank = 0.77;
    g.memories[a].rankUpdatedAtTurn = 99;
    await graphDb.saveGraph(g);

    const row = await memoriesDb.getMemory(a);
    expect(row?.rank).toBeCloseTo(0.77);
  });

  it('saveGraph skips memories with rankUpdatedAtTurn === 0', async () => {
    const a = await seedMem('a');
    const g = await graphDb.loadGraph();
    g.memories[a].rank = 0.77;
    g.memories[a].rankUpdatedAtTurn = 0;
    await graphDb.saveGraph(g);

    const row = await memoriesDb.getMemory(a);
    expect(row?.rank).toBeCloseTo(0.15); // default, unchanged
  });

  it('reinforceEdge updates in-memory graph AND SQLite', async () => {
    const a = await seedMem('a');
    const b = await seedMem('b');
    const g = await graphDb.loadGraph();
    const config = {
      reinforcementDelta: 0.2,
      invalidationLambda: 0.5,
      activationTau: 50,
      pageRankDamping: 0.85,
      topKOutgoing: 10,
      rankRefreshEveryTurns: 5,
      pruneLiftFloor: 0.1,
      pruneTrustFloor: 0.1,
      pruneDormancyTurns: 100,
      similarityAlpha: 0.5,
      similarityBeta: 0.3,
      similarityGamma: 0.1,
      similarityDelta: 0.1,
      intentGapMinutes: 30,
    };

    await graphDb.reinforceEdge(g, a, b, 7, config);

    expect(g.memories[a].outgoingEdges[b].weight).toBeCloseTo(0.2);
    expect(g.memories[a].outgoingEdges[b].coRetrievalCount).toBe(1);
    expect(g.memories[b].incomingEdges[a].weight).toBeCloseTo(0.2);

    const dbEdge = await edgesDb.getEdge(a, b);
    expect(dbEdge?.weight).toBeCloseTo(0.2);
  });

  it('reinforceEdge enforces topKOutgoing cap by evicting weakest', async () => {
    const src = await seedMem('src');
    const ids = await Promise.all(['t1', 't2', 't3', 't4'].map(seedMem));
    const g = await graphDb.loadGraph();
    const config = {
      reinforcementDelta: 0.1,
      invalidationLambda: 0.5,
      activationTau: 50,
      pageRankDamping: 0.85,
      topKOutgoing: 2, // tight cap
      rankRefreshEveryTurns: 5,
      pruneLiftFloor: 0.1,
      pruneTrustFloor: 0.1,
      pruneDormancyTurns: 100,
      similarityAlpha: 0.5,
      similarityBeta: 0.3,
      similarityGamma: 0.1,
      similarityDelta: 0.1,
      intentGapMinutes: 30,
    };

    // Reinforce with ascending weights: t1 weakest, t4 strongest
    await graphDb.reinforceEdge(g, src, ids[0], 1, { ...config, reinforcementDelta: 0.05 });
    await graphDb.reinforceEdge(g, src, ids[1], 1, { ...config, reinforcementDelta: 0.1 });
    await graphDb.reinforceEdge(g, src, ids[2], 1, { ...config, reinforcementDelta: 0.2 });
    await graphDb.reinforceEdge(g, src, ids[3], 1, { ...config, reinforcementDelta: 0.3 });

    const outIds = Object.keys(g.memories[src].outgoingEdges);
    expect(outIds.length).toBeLessThanOrEqual(2);
    // Strongest should survive
    expect(outIds).toContain(ids[3]);
  });

  it('recordRetrieval delegates to memoriesDb', async () => {
    const a = await seedMem('a');
    await graphDb.recordRetrieval(a, 42);
    const row = await memoriesDb.getMemory(a);
    expect(row?.retrieval_count).toBe(1);
    expect(row?.last_retrieved_turn).toBe(42);
  });

  it('getGraphStats returns totals from SQLite', async () => {
    const a = await seedMem('a');
    const b = await seedMem('b');
    await edgesDb.reinforceEdge(a, b, 0.1, 1);
    await memoriesDb.updateMemoryRank(a, 0.9, 1);

    const stats = await graphDb.getGraphStats();
    expect(stats.totalMemories).toBe(2);
    expect(stats.totalEdges).toBe(1);
    expect(stats.highestRank).toBeCloseTo(0.9);
  });

  it('loadGraph returns MemoryNode (topics only, no transcript/embedding)', async () => {
    const a = await seedMem('a');
    await transcriptsDb.createTranscript({
      memoryId: a,
      transcript: 'real transcript',
      topics: ['x', 'y'],
      embedding: [0.1, 0.2, 0.3],
    });

    const g = await graphDb.loadGraph();
    // Topics are small JSON and needed by the hot-path classifier, so
    // they're on MemoryNode. Transcript + embedding stay off to keep
    // BLOB reads out of every graph scan.
    expect(g.memories[a].topics).toEqual(['x', 'y']);
    expect(g.memories[a]).not.toHaveProperty('transcript');
    expect(g.memories[a]).not.toHaveProperty('embedding');
  });

  it('loadGraph returns empty topics for memories without transcripts', async () => {
    const a = await seedMem('a');
    const g = await graphDb.loadGraph();
    expect(g.memories[a].topics).toEqual([]);
  });

  it('loadGraphFull hydrates transcript and topics, but not embedding (loaded on-demand — see getAllTranscripts)', async () => {
    const a = await seedMem('a');
    await transcriptsDb.createTranscript({
      memoryId: a,
      transcript: 'real transcript',
      topics: ['x', 'y'],
      embedding: [0.1, 0.2, 0.3],
    });

    const g = await graphDb.loadGraphFull();
    expect(g.memories[a].transcript).toBe('real transcript');
    expect(g.memories[a].topics).toEqual(['x', 'y']);
    // getAllTranscripts() deliberately excludes the embedding BLOB (saves ~2.3MB
    // on slow networks) — real callers (e.g. cli/commands/recall.ts) patch
    // .embedding on-demand per-candidate via getEmbeddingsByIds afterward.
    expect(g.memories[a].embedding).toBeNull();
  });

  it('loadGraphFull returns empty defaults for memories without transcripts', async () => {
    const a = await seedMem('a');
    const g = await graphDb.loadGraphFull();
    expect(g.memories[a].transcript).toBe('');
    expect(g.memories[a].topics).toEqual([]);
    expect(g.memories[a].embedding).toBeNull();
  });

  it('computeLift: weight over sqrt(retrievalCountA * retrievalCountB)', () => {
    const edge = { weight: 1.0, coRetrievalCount: 5, invalidationCount: 0, lastReinforcedTurn: 1, lastReinforcedAt: '', lastInvalidatedTurn: null };
    const memA = { retrievalCount: 4 } as any;
    const memB = { retrievalCount: 9 } as any;
    const lift = graphDb.computeLift(edge, memA, memB);
    expect(lift).toBeCloseTo(1.0 / Math.sqrt(36));
  });

  it('computeTrust: weight / (weight + invalidations * lambda)', () => {
    const edge = { weight: 1.0, coRetrievalCount: 5, invalidationCount: 2, lastReinforcedTurn: 1, lastReinforcedAt: '', lastInvalidatedTurn: null };
    const trust = graphDb.computeTrust(edge, 0.5);
    expect(trust).toBeCloseTo(1.0 / (1.0 + 2 * 0.5));
  });

  it('loadGraph excludes quarantined schema nodes', async () => {
    const real = await seedMem('real-episode');
    await memoriesDb.createMemory({
      snapshotName: 'gist-cluster',
      title: 'gist-cluster',
      summary: 'a synthesized gist',
      contentType: 'schema',
      projectPath: '/tmp',
      tokenCount: 0,
      createdAtTurn: 1,
    });

    const g = await graphDb.loadGraph();
    expect(g.memories[real]).toBeDefined();
    const schemaRow = await memoriesDb.getMemoryBySnapshot('gist-cluster');
    expect(schemaRow).not.toBeNull();
    expect(g.memories[schemaRow!.id]).toBeUndefined(); // quarantined — not in graph
  });

  it('loadGraphFull excludes quarantined schema nodes', async () => {
    const real = await seedMem('episode-a');
    const schemaId = await memoriesDb.createMemory({
      snapshotName: 'schema-gist',
      title: 'schema-gist',
      summary: 'synthesized cluster',
      contentType: 'schema',
      projectPath: '/tmp',
      tokenCount: 0,
      createdAtTurn: 1,
    });

    const g = await graphDb.loadGraphFull();
    expect(g.memories[real]).toBeDefined();
    expect(g.memories[schemaId]).toBeUndefined();
  });

  it('computeActivation: 1.0 for never-retrieved, decays otherwise', () => {
    const never = { lastRetrievedTurn: 0 } as any;
    const fresh = { lastRetrievedTurn: 100 } as any;
    expect(graphDb.computeActivation(never, 100, 50)).toBe(1.0);
    // 0 turns since retrieval → exp(0) = 1
    expect(graphDb.computeActivation(fresh, 100, 50)).toBeCloseTo(1.0);
    // 50 turns since retrieval → exp(-1)
    expect(graphDb.computeActivation(fresh, 150, 50)).toBeCloseTo(Math.exp(-1));
  });
});
