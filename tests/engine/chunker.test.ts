import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import {
  chunkText,
  chunkAndPersistMemory,
  chunkIdFor,
  estimateTokens,
  truncateForEmbedding,
  CHUNKER_VERSION,
} from '../../src/engine/chunker.js';
import { embed } from '../../src/utils/llm.js';
import { encodeEmbedding, decodeEmbedding } from '../../src/utils/embedding-codec.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as chunksDb from '../../src/store/db/chunks.js';

describe('engine/chunker — pure splitter', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps short input as a single chunk', () => {
    const out = chunkText('Alice: hi there.\nClaude: hello.');
    expect(out).toHaveLength(1);
    expect(out[0].index).toBe(0);
    expect(out[0].text).toContain('Alice');
    expect(out[0].text).toContain('Claude');
  });

  it('splits on blank-line boundaries when total exceeds target', () => {
    const para = 'word '.repeat(80);  // ~400 chars / 4 ≈ 100 tokens
    const text = [para, para, para, para].join('\n\n');
    const out = chunkText(text, { targetTokens: 150, maxTokens: 250, minTokens: 30 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text.length).toBeGreaterThan(0);
    }
    // chunk indices are 0..n-1 monotonic
    expect(out.map(c => c.index)).toEqual(out.map((_, i) => i));
  });

  it('keeps a fenced code block intact even when it spans blank lines', () => {
    const code = ['```ts', 'function foo() {', '', '  return 1;', '}', '```'].join('\n');
    const out = chunkText(`Some prose.\n\n${code}\n\nMore prose.`);
    // Find the chunk containing the fence — it should hold both fence markers.
    const fenceChunk = out.find(c => c.text.includes('```ts'));
    expect(fenceChunk).toBeDefined();
    expect(fenceChunk!.text).toContain('```ts');
    expect(fenceChunk!.text.match(/```/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('sub-splits a single oversized block on sentence boundaries', () => {
    const longBlock = 'This is a sentence. '.repeat(200); // ~4000 chars → ~1000 tok
    const out = chunkText(longBlock, { targetTokens: 100, maxTokens: 150 });
    expect(out.length).toBeGreaterThan(3);
    for (const c of out) {
      // No chunk should massively exceed the cap (sentence-split lower-bounds
      // by sentence size; we tolerate a small overshoot).
      expect(c.tokenCount).toBeLessThanOrEqual(200);
    }
  });

  it('hard-slices a single sentence that exceeds maxTokens', () => {
    const longRun = 'a'.repeat(3000); // no sentence boundary, ~750 tokens
    const out = chunkText(longRun, { targetTokens: 100, maxTokens: 150 });
    expect(out.length).toBeGreaterThan(1);
    // Concatenation should preserve all the 'a's.
    const total = out.map(c => c.text).join('').replace(/\s/g, '');
    expect(total.length).toBe(3000);
  });

  it('estimateTokens uses chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('chunkIdFor produces stable slug#N ids', () => {
    expect(chunkIdFor('oauth-token-flow', 0)).toBe('oauth-token-flow#0');
    expect(chunkIdFor('mem', 12)).toBe('mem#12');
  });

  it('CHUNKER_VERSION is set to v1', () => {
    expect(CHUNKER_VERSION).toBe('v1');
  });

  it('truncateForEmbedding leaves short text untouched and caps long text at 800 chars', () => {
    const short = 'a'.repeat(500);
    expect(truncateForEmbedding(short)).toBe(short);
    const long = 'b'.repeat(2000);
    const truncated = truncateForEmbedding(long);
    expect(truncated.length).toBe(800);
    expect(truncated).toBe(long.slice(0, 800));
  });
});

describe('engine/chunker — chunkAndPersistMemory', () => {
  useTestDb();

  async function seedMemory(slug = 'mem-a'): Promise<string> {
    return memoriesDb.createMemory({
      snapshotName: slug,
      title: slug,
      contentType: 'text',
      projectPath: '/tmp/proj',
      tokenCount: 100,
      createdAtTurn: 1,
    });
  }

  it('persists chunks with stable ids, embeddings, and chunker_version', async () => {
    const memId = await seedMemory('mem-stable');
    const transcript = ['Alice: hello.', 'Claude: hi.', '', 'Alice: bye.'].join('\n');
    const result = await chunkAndPersistMemory(memId, 'mem-stable', transcript, {
      targetTokens: 30,
      maxTokens: 60,
      minTokens: 5,
    });

    expect(result.count).toBeGreaterThan(0);
    // JOHNNY_LLM_MOCK is on for tests → embed() returns deterministic vectors.
    expect(result.embedded).toBe(result.count);
    expect(result.skipped).toBe(0);

    const persisted = await chunksDb.getChunksForMemory(memId);
    expect(persisted.length).toBe(result.count);
    for (let i = 0; i < persisted.length; i++) {
      expect(persisted[i].chunk_id).toBe(`mem-stable#${i}`);
      expect(persisted[i].chunk_index).toBe(i);
      expect(persisted[i].chunker_version).toBe('v1');
      expect(persisted[i].embedding_model).toBeTruthy();
      expect(persisted[i].embedding).not.toBeNull();
      expect(persisted[i].text.trim().length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: re-running replaces chunks (no duplicate-key error)', async () => {
    const memId = await seedMemory('mem-idem');
    const text = 'Alice: foo bar baz.\n\nClaude: alpha beta gamma.';
    await chunkAndPersistMemory(memId, 'mem-idem', text);
    const first = await chunksDb.getChunksForMemory(memId);
    await chunkAndPersistMemory(memId, 'mem-idem', text);
    const second = await chunksDb.getChunksForMemory(memId);
    expect(second.map(c => c.chunk_id)).toEqual(first.map(c => c.chunk_id));
  });

  it('returns zero counts for empty transcript', async () => {
    const memId = await seedMemory('mem-empty');
    const result = await chunkAndPersistMemory(memId, 'mem-empty', '');
    expect(result).toEqual({ count: 0, embedded: 0, skipped: 0, duplicates: 0 });
    expect(await chunksDb.getChunksForMemory(memId)).toEqual([]);
  });

  it('embeddings round-trip via getChunkEmbedding', async () => {
    const memId = await seedMemory('mem-emb');
    await chunkAndPersistMemory(memId, 'mem-emb', 'Alice: one two three four.');
    const vec = await chunksDb.getChunkEmbedding('mem-emb#0');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec!.length).toBeGreaterThan(0);
  });

  it('a deadline already in the past skips embedding but still persists every chunk', async () => {
    const memId = await seedMemory('mem-deadline');
    const text = ['Alice: hello.', 'Claude: hi.', '', 'Alice: bye.'].join('\n');
    const result = await chunkAndPersistMemory(memId, 'mem-deadline', text, {
      targetTokens: 5, maxTokens: 10, minTokens: 1,
      deadline: Date.now() - 1000,
    });
    expect(result.count).toBeGreaterThan(0);
    expect(result.embedded).toBe(0);
    expect(result.skipped).toBe(result.count);

    const persisted = await chunksDb.getChunksForMemory(memId);
    expect(persisted.length).toBe(result.count);
    for (const c of persisted) {
      expect(c.embedding).toBeNull();
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('embeds a chunk exceeding the embed-model context using only the first 800 chars (regression: Ollama 500s on oversized input)', async () => {
    const memId = await seedMemory('mem-oversized');
    // No sentence/paragraph boundaries so it stays a single chunk under a
    // generous budget, but is well over the 800-char embed-input cap. (Plain words,
    // not one opaque token: cleanForEmbedding deliberately collapses 40+ char
    // tokens — see tests/engine/embedding-prep.test.ts — which would change the input.)
    const text = 'word '.repeat(240).trim();
    const result = await chunkAndPersistMemory(memId, 'mem-oversized', text, {
      targetTokens: 1000, maxTokens: 2000, minTokens: 1,
    });
    expect(result.count).toBe(1);
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(0);

    const persisted = await chunksDb.getChunksForMemory(memId);
    // Full text is still stored — only the embedding input was truncated.
    expect(persisted[0].text).toBe(text);

    // Embeddings persist through a lossy float32 buffer (see embedding-codec.ts),
    // so round-trip the comparison values the same way rather than comparing
    // against the raw float64 mock output directly.
    const stored = await chunksDb.getChunkEmbedding('mem-oversized#0');
    const expectedFromTruncated = decodeEmbedding(encodeEmbedding(await embed(text.slice(0, 800))));
    const wouldBeFromFullText = decodeEmbedding(encodeEmbedding(await embed(text)));
    expect(stored).toEqual(expectedFromTruncated);
    expect(stored).not.toEqual(wouldBeFromFullText);
  });

  it('an unset deadline embeds every chunk (unbounded — unchanged default behavior)', async () => {
    const memId = await seedMemory('mem-no-deadline');
    const text = Array.from({ length: 10 }, (_, i) => `Alice: turn ${i} says something.`).join('\n\n');
    const result = await chunkAndPersistMemory(memId, 'mem-no-deadline', text, {
      targetTokens: 5, maxTokens: 10, minTokens: 1,
    });
    expect(result.count).toBeGreaterThan(1);
    expect(result.embedded).toBe(result.count);
    expect(result.skipped).toBe(0);
  });
});
