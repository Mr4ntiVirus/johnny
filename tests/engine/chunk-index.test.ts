import { describe, it, expect, beforeEach } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as chunksDb from '../../src/store/db/chunks.js';
import { chunkAndPersistMemory } from '../../src/engine/chunker.js';
import { ChunkIndex, getChunkIndex, resetChunkIndexCache, normalise } from '../../src/engine/chunk-index.js';
import { selectRecall, handleRecall } from '../../src/mcp/index.js';

describe('ChunkIndex.search (pure)', () => {
  const mk = (id: string, mem: string, v: number[]) => ({ chunkId: id, memoryId: mem, tokenCount: 10, vec: normalise(v) });
  const memories = new Map([
    ['m1', { id: 'm1', name: 'mem-one', rank: 0.9, createdAt: '2026-10-01' }],
    ['m2', { id: 'm2', name: 'mem-two', rank: 0.1, createdAt: '2026-10-02' }],
  ]);

  it('lifts chunks holding a rare query term (hybrid lexical bonus) without changing their raw cosine', () => {
    const idx = new ChunkIndex([
      mk('hi#0', 'm1', [1, 0, 0]),
      mk('lex#0', 'm1', [0.9, 0.436, 0]),   // same memory (equal prior); lower cosine, but it names the rare term
    ], memories, 'sig');
    const plain = idx.search([1, 0, 0], 10);
    expect(plain.map(h => h.chunkId)).toEqual(['hi#0', 'lex#0']);
    const hybrid = idx.search([1, 0, 0], 10, { lexicalChunkIds: new Set(['lex#0']) });
    expect(hybrid.map(h => h.chunkId)).toEqual(['lex#0', 'hi#0']);
    expect(hybrid[0].cosine).toBeCloseTo(0.9, 2);   // reported cosine stays the real similarity
  });

  it('orders by cosine, caps per memory, honours exclusions, ignores other-dimension vectors', () => {
    const idx = new ChunkIndex([
      mk('a#0', 'm1', [1, 0, 0]),
      mk('a#1', 'm1', [0.8, 0.6, 0]),
      mk('a#2', 'm1', [0.6, 0.8, 0]),
      mk('b#0', 'm2', [0.5, 0, 0.866]),
      mk('odd#0', 'm2', [1, 0]), // wrong dimension: skipped
    ], memories, 'sig');
    const hits = idx.search([1, 0, 0], 10, { maxPerMemory: 2 });
    expect(hits.map(h => h.chunkId)).toEqual(['a#0', 'a#1', 'b#0']);
    expect(hits[0].cosine).toBeCloseTo(1, 5);
    const paged = idx.search([1, 0, 0], 10, { excludeChunkIds: new Set(['a#0']), maxPerMemory: 2 });
    expect(paged.map(h => h.chunkId)).toEqual(['a#1', 'a#2', 'b#0']);
  });

  it('drops near-duplicate chunks (shifted-boundary copies) from one answer', () => {
    const idx = new ChunkIndex([
      mk('a#0', 'm1', [1, 0.0, 0]),
      mk('b#0', 'm2', [1, 0.02, 0]),   // cosine ≈ 0.9998 with a#0: a near-copy
      mk('c#0', 'm2', [0.6, 0.8, 0]),  // genuinely different
    ], memories, 'sig');
    const hits = idx.search([1, 0.05, 0], 10);
    expect(hits).toHaveLength(2);
    expect(hits.some(h => h.chunkId === 'b#0')).toBe(false); // the near-copy of a#0 is gone
    expect(hits.some(h => h.chunkId === 'c#0')).toBe(true);
    // nearDupCosine > 1 disables the filter
    expect(idx.search([1, 0.05, 0], 10, { nearDupCosine: 1.01 })).toHaveLength(3);
  });

  it('applies a mild memory-rank prior without overriding relevance', () => {
    const idx = new ChunkIndex([
      mk('hi#0', 'm1', [0.95, 0.312, 0]), // high-rank memory, slightly less similar
      mk('lo#0', 'm2', [1, 0.0, 0]),      // low-rank memory, exact
    ], memories, 'sig');
    const hits = idx.search([1, 0, 0], 2);
    // near-equal relevance: rank prior may reorder, but both are returned and cosines are raw
    expect(new Set(hits.map(h => h.chunkId))).toEqual(new Set(['hi#0', 'lo#0']));
    expect(hits.find(h => h.chunkId === 'lo#0')!.cosine).toBeCloseTo(1, 5);
  });
});

describe('chunk-first recall (DB-backed)', () => {
  useTestDb();
  beforeEach(() => resetChunkIndexCache());

  async function seed(slug: string, text: string, summary?: string): Promise<string> {
    const id = await memoriesDb.createMemory({
      snapshotName: slug, title: slug, contentType: 'text', summary,
      projectPath: '/tmp/p', tokenCount: 10, createdAtTurn: 1,
    });
    await chunkAndPersistMemory(id, slug, text, { targetTokens: 40, maxTokens: 80, minTokens: 5 });
    return id;
  }

  it('finds the memory holding the answer even when many memories share one summary', async () => {
    // 12 clone memories with the SAME summary + unrelated content...
    for (let i = 0; i < 12; i++) {
      await seed(`clone-${i}`, `Alice: unrelated chatter number ${i} about lunch plans.\n\nClaude: ok sounds good.`,
        'Implemented Praxis sprint tasks for skill discovery.');
    }
    // ...and one memory that actually holds the answer.
    const answerId = await seed('the-answer', 'Alice: how does mosaic recall rerank work?\n\nClaude: Mosaic recall scores every chunk then reranks the top thirty with a small model.');
    // Mock embeddings are deterministic per exact text, so query with the stored chunk text.
    const answerChunk = (await chunksDb.getChunksForMemory(answerId))[0];

    const sel = await selectRecall({ query: answerChunk.text, limit: 5 });
    expect('empty' in sel).toBe(false);
    if ('empty' in sel) return;
    expect(sel.selected[0].memoryName).toBe('the-answer');
    expect(sel.selected[0].score).toBeGreaterThan(0.99);
  });

  it('never returns two tiles with identical text', async () => {
    await seed('dup-a', 'Alice: same words here for the relay.\n\nClaude: relay answer text identical.');
    await seed('dup-b', 'Alice: same words here for the relay.\n\nClaude: relay answer text identical.'); // write-time dedup stores nothing
    const sel = await selectRecall({ query: 'same words here for the relay', limit: 8 });
    if ('empty' in sel) throw new Error('unexpected empty');
    const texts = sel.selected.map(t => t.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('paginates with excludeChunkIds without repeating tiles', async () => {
    await seed('page', Array.from({ length: 8 }, (_, i) => `Alice: topic ${i} relay.\n\nClaude: answer ${i} about the relay config.`).join('\n\n'));
    const first = await selectRecall({ query: 'relay config', limit: 2, tokenBudget: 4000 });
    if ('empty' in first) throw new Error('unexpected empty');
    const ids = first.selected.map(t => t.chunkId);
    const second = await selectRecall({ query: 'relay config', limit: 2, tokenBudget: 4000, excludeChunkIds: ids });
    if ('empty' in second) throw new Error('unexpected empty');
    for (const t of second.selected) expect(ids).not.toContain(t.chunkId);
  });

  it('falls back to the legacy path in names mode', async () => {
    await seed('by-name', 'Alice: hello.\n\nClaude: hi there friend.');
    const out = await handleRecall({ names: ['by-name'] });
    expect(out.content[0].text).toContain('by-name');
  });

  it('getChunkIndex returns null for an empty store and rebuilds when chunks change', async () => {
    expect(await getChunkIndex({ force: true })).toBeNull();
    await seed('first', 'Alice: first memory text here.\n\nClaude: acknowledged the first memory.');
    const a = await getChunkIndex({ force: true });
    expect(a?.size).toBeGreaterThan(0);
    await seed('second', 'Alice: second memory with different words.\n\nClaude: acknowledged the second one too.');
    const b = await getChunkIndex({ force: true });
    expect(b!.size).toBeGreaterThan(a!.size);
  });
});


describe('chunksDb.lexicalChunkIds', () => {
  useTestDb();
  it('returns chunks containing rare query terms, ignores absent and over-common terms', async () => {
    const mid = await memoriesDb.createMemory({ snapshotName: 'lex-mem', title: 't', summary: 's', contentType: 'text', projectPath: '/x' } as never);
    const mk = (i: number, text: string) => ({ chunkId: `lex-mem#${i}`, memoryId: mid, chunkIndex: i, text, tokenCount: 5 });
    await chunksDb.createChunks([
      mk(0, 'the Mosaic continuation design is stateless'),
      mk(1, 'ordinary words about recall and recall again'),
      ...Array.from({ length: 5 }, (_, i) => mk(i + 2, `common word recall appears everywhere ${i}`)),
    ]);
    const hit = await chunksDb.lexicalChunkIds('mosaic design nonexistentterm');
    expect([...hit]).toEqual(['lex-mem#0']);
    const tooCommon = await chunksDb.lexicalChunkIds('everywhere', { maxChunksPerTerm: 3 });
    expect(tooCommon.size).toBe(0);
  });
});
