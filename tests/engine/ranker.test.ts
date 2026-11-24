// Coverage for the MemoryNode → DB-hydrated-embedding hot path introduced in
// Phase A.15. rankBySimilarity must pull embeddings from transcripts.embedding
// when given MemoryNode input (no inline .embedding field), while still
// honoring inline embeddings when given MemoryFull input.
import { describe, it, expect, beforeAll } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { rankBySimilarity } from '../../src/engine/embedder.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as transcriptsDb from '../../src/store/db/transcripts.js';
import type { MemoryNode, MemoryFull } from '../../src/types.js';

beforeAll(() => {
  process.env.JOHNNY_LLM_MOCK = '1';
});

async function seedNode(slug: string, embedding?: number[]): Promise<MemoryNode> {
  const id = await memoriesDb.createMemory({
    snapshotName: slug,
    title: slug,
    summary: `${slug} summary`,
    contentType: 'text',
    projectPath: '/tmp',
    tokenCount: 10,
    createdAtTurn: 1,
  });
  if (embedding) {
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: `${slug} transcript`,
      topics: [slug],
      embedding,
    });
  }
  return {
    id,
    snapshotName: slug,
    title: slug,
    summary: `${slug} summary`,
    projectPath: '/tmp',
    tokenCount: 10,
    topics: [slug],
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: 1,
    createdAt: new Date().toISOString(),
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0.15,
    rankUpdatedAtTurn: 0,
  };
}

describe('rankBySimilarity — MemoryNode input (DB-hydrated embeddings)', () => {
  useTestDb();

  it('empty input returns empty', async () => {
    expect(await rankBySimilarity('anything', [])).toEqual([]);
  });

  it('returns empty when no memories have embeddings in the DB', async () => {
    const a = await seedNode('alpha'); // no embedding
    const b = await seedNode('beta');  // no embedding
    const ranked = await rankBySimilarity('hello', [a, b]);
    expect(ranked).toEqual([]);
  });

  it('pulls embeddings from transcripts.embedding for MemoryNode[] input', async () => {
    const a = await seedNode('alpha', [1, 0, 0, 0]);
    const b = await seedNode('beta', [0, 1, 0, 0]);
    const c = await seedNode('gamma'); // no embedding — must be skipped
    const ranked = await rankBySimilarity('any query', [a, b, c]);
    // Both a and b are rankable; c is not.
    expect(ranked.map(r => r.memory.id).sort()).toEqual([a.id, b.id].sort());
    // Scores are in [0,1] via mock embed
    for (const r of ranked) expect(r.similarity).toBeGreaterThanOrEqual(0);
  });

  it('orders by similarity descending', async () => {
    const a = await seedNode('alpha', [1, 0, 0, 0]);
    const b = await seedNode('beta', [0.9, 0.1, 0, 0]);
    const c = await seedNode('gamma', [-1, 0, 0, 0]);
    const ranked = await rankBySimilarity('q', [a, b, c]);
    for (let i = 0; i + 1 < ranked.length; i++) {
      expect(ranked[i].similarity).toBeGreaterThanOrEqual(ranked[i + 1].similarity);
    }
  });

  it('respects topK', async () => {
    const nodes: MemoryNode[] = [];
    for (let i = 0; i < 5; i++) nodes.push(await seedNode(`m${i}`, [i, 0, 0, 0]));
    const ranked = await rankBySimilarity('q', nodes, 2);
    expect(ranked.length).toBe(2);
  });

  it('uses inline embedding when given MemoryFull with .embedding populated (no DB read)', async () => {
    const a = await seedNode('alpha'); // NO embedding in DB
    // Construct a MemoryFull with an inline embedding — the ranker should
    // honor it without needing the DB row.
    const full: MemoryFull = {
      ...a,
      transcript: 'x',
      embedding: [1, 0, 0, 0],
    };
    const ranked = await rankBySimilarity('q', [full]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].memory.id).toBe(a.id);
  });
});
