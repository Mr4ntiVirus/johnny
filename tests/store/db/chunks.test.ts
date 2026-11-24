import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as chunksDb from '../../../src/store/db/chunks.js';
import * as memoriesDb from '../../../src/store/db/memories.js';

describe('db/chunks.ts', () => {
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

  it('createChunk persists with embedding round-trip', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({
      chunkId: 'mem-a#0',
      memoryId: memId,
      chunkIndex: 0,
      text: 'first slice',
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'nomic-embed-text',
      tokenCount: 25,
    });

    const row = await chunksDb.getChunk('mem-a#0');
    expect(row?.chunk_id).toBe('mem-a#0');
    expect(row?.memory_id).toBe(memId);
    expect(row?.text).toBe('first slice');
    expect(row?.embedding_model).toBe('nomic-embed-text');
    expect(row?.token_count).toBe(25);
    // Embeddings are stored as float32 bytes, so compare with float32 tolerance.
    const emb = await chunksDb.getChunkEmbedding('mem-a#0');
    expect(emb).toHaveLength(3);
    [0.1, 0.2, 0.3].forEach((v, i) => expect(emb![i]).toBeCloseTo(v, 6));
  });

  it('getChunksForMemory returns ordered by chunk_index', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunks([
      { chunkId: 'a#2', memoryId: memId, chunkIndex: 2, text: 'third' },
      { chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'first' },
      { chunkId: 'a#1', memoryId: memId, chunkIndex: 1, text: 'second' },
    ]);
    const rows = await chunksDb.getChunksForMemory(memId);
    expect(rows.map(r => r.text)).toEqual(['first', 'second', 'third']);
  });

  it('UNIQUE(memory_id, chunk_index) prevents duplicate index per memory', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'one' });
    await expect(
      chunksDb.createChunk({ chunkId: 'b#0', memoryId: memId, chunkIndex: 0, text: 'two' })
    ).rejects.toThrow();
  });

  it('PK(chunk_id) prevents duplicate chunk ids', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'dup', memoryId: memId, chunkIndex: 0, text: 'x' });
    await expect(
      chunksDb.createChunk({ chunkId: 'dup', memoryId: memId, chunkIndex: 1, text: 'y' })
    ).rejects.toThrow();
  });

  it('memory delete cascades to chunks (FK)', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'x' });
    expect(await chunksDb.getChunkCount()).toBe(1);
    await memoriesDb.deleteMemory(memId);
    expect(await chunksDb.getChunkCount()).toBe(0);
  });

  it('deleteChunksForMemory removes only that memory\'s chunks', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: a, chunkIndex: 0, text: 'x' });
    await chunksDb.createChunk({ chunkId: 'b#0', memoryId: b, chunkIndex: 0, text: 'y' });
    await chunksDb.deleteChunksForMemory(a);
    expect(await chunksDb.getChunksForMemory(a)).toEqual([]);
    expect(await chunksDb.getChunksForMemory(b)).toHaveLength(1);
  });

  it('getChunkEmbeddingsForMemory pairs ids to vectors', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'x', embedding: [1, 0] });
    await chunksDb.createChunk({ chunkId: 'a#1', memoryId: memId, chunkIndex: 1, text: 'y', embedding: [0, 1] });
    await chunksDb.createChunk({ chunkId: 'a#2', memoryId: memId, chunkIndex: 2, text: 'z' });
    const pairs = await chunksDb.getChunkEmbeddingsForMemory(memId);
    expect(pairs).toEqual([
      { chunkId: 'a#0', embedding: [1, 0] },
      { chunkId: 'a#1', embedding: [0, 1] },
      { chunkId: 'a#2', embedding: null },
    ]);
  });

  it('listChunkIds filters by memoryIds', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: a, chunkIndex: 0, text: 'x' });
    await chunksDb.createChunk({ chunkId: 'b#0', memoryId: b, chunkIndex: 0, text: 'y' });
    expect(await chunksDb.listChunkIds({ memoryIds: [a] })).toEqual(['a#0']);
    expect((await chunksDb.listChunkIds()).sort()).toEqual(['a#0', 'b#0']);
  });

  it('getChunksNeedingEmbedding returns only null-embedding chunks, respecting limit', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'has embedding', embedding: [1, 0] });
    await chunksDb.createChunk({ chunkId: 'a#1', memoryId: memId, chunkIndex: 1, text: 'needs embedding one' });
    await chunksDb.createChunk({ chunkId: 'a#2', memoryId: memId, chunkIndex: 2, text: 'needs embedding two' });

    const all = await chunksDb.getChunksNeedingEmbedding(10);
    expect(all.map(r => r.chunk_id).sort()).toEqual(['a#1', 'a#2']);

    const limited = await chunksDb.getChunksNeedingEmbedding(1);
    expect(limited).toHaveLength(1);
  });

  it('setChunkEmbedding writes an embedding that getChunkEmbedding reads back', async () => {
    const memId = await seedMemory();
    await chunksDb.createChunk({ chunkId: 'a#0', memoryId: memId, chunkIndex: 0, text: 'x' });
    expect(await chunksDb.getChunkEmbedding('a#0')).toBeNull();

    await chunksDb.setChunkEmbedding('a#0', [0.5, 0.25], 'mxbai-embed-large');

    const row = await chunksDb.getChunk('a#0');
    expect(row?.embedding_model).toBe('mxbai-embed-large');
    expect(await chunksDb.getChunkEmbedding('a#0')).not.toBeNull();
    expect(await chunksDb.getChunksNeedingEmbedding(10)).toEqual([]);
  });
});
