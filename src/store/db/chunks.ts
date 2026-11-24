// chunks — sub-memory units for Mosaic Recall (Phase G/H).

import { query, queryOne, execute } from '../db-client.js';
import { encodeEmbedding, decodeEmbedding } from '../../utils/embedding-codec.js';
import { contentHash } from '../../utils/content-hash.js';

export interface ChunkInput {
  chunkId: string;
  memoryId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
  embeddingModel?: string;
  chunkerVersion?: string;
  tokenCount?: number;
  /** sha256 of whitespace-normalised text; computed from `text` when omitted. */
  contentHash?: string;
}

export interface ChunkRecord {
  chunk_id: string;
  memory_id: string;
  chunk_index: number;
  text: string;
  embedding: Buffer | null;
  embedding_model: string | null;
  chunker_version: string | null;
  token_count: number;
  created_at: string;
  content_hash?: string | null;
}

function bufferFromEmbedding(e: number[] | undefined): Buffer | null {
  return e ? encodeEmbedding(e) : null;
}

function embeddingFromBuffer(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  try { return decodeEmbedding(buf); } catch { return null; }
}

export async function createChunk(input: ChunkInput): Promise<void> {
  await execute(
    `INSERT INTO chunks
       (chunk_id, memory_id, chunk_index, text, embedding, embedding_model, chunker_version, token_count, created_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.chunkId, input.memoryId, input.chunkIndex, input.text,
     bufferFromEmbedding(input.embedding), input.embeddingModel ?? null,
     input.chunkerVersion ?? null, input.tokenCount ?? 0, new Date().toISOString(),
     input.contentHash ?? contentHash(input.text)],
  );
}

/**
 * Which of these content hashes already exist as stored chunks, optionally
 * ignoring one memory (so re-chunking a memory doesn't see its own old chunks).
 */
export async function existingChunkHashes(hashes: string[], excludeMemoryId?: string): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(hashes)];
  for (let i = 0; i < unique.length; i += 400) {
    const slice = unique.slice(i, i + 400);
    const rows = await query<{ content_hash: string }>(
      `SELECT DISTINCT content_hash FROM chunks WHERE content_hash IN (${slice.map(() => '?').join(',')})`
        + (excludeMemoryId ? ' AND memory_id != ?' : ''),
      excludeMemoryId ? [...slice, excludeMemoryId] : slice);
    for (const r of rows) found.add(r.content_hash);
  }
  return found;
}

export async function createChunks(inputs: ChunkInput[]): Promise<void> {
  for (const c of inputs) {
    await createChunk(c);
  }
}

export async function getChunk(chunkId: string): Promise<ChunkRecord | null> {
  return queryOne<ChunkRecord>('SELECT * FROM chunks WHERE chunk_id = ?', [chunkId]);
}

export async function getChunksForMemory(memoryId: string): Promise<ChunkRecord[]> {
  return query<ChunkRecord>('SELECT * FROM chunks WHERE memory_id = ? ORDER BY chunk_index ASC', [memoryId]);
}

export async function getChunkTexts(chunkIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < chunkIds.length; i += 400) {
    const slice = chunkIds.slice(i, i + 400);
    const rows = await query<{ chunk_id: string; text: string }>(
      `SELECT chunk_id, text FROM chunks WHERE chunk_id IN (${slice.map(() => '?').join(',')})`, slice);
    for (const r of rows) out.set(r.chunk_id, r.text);
  }
  return out;
}

export async function getChunkEmbedding(chunkId: string): Promise<number[] | null> {
  const row = await queryOne<{ embedding: Buffer | null }>('SELECT embedding FROM chunks WHERE chunk_id = ?', [chunkId]);
  return row ? embeddingFromBuffer(row.embedding) : null;
}

export async function getChunkEmbeddingsForMemory(memoryId: string): Promise<{ chunkId: string; embedding: number[] | null }[]> {
  const rows = await query<{ chunk_id: string; embedding: Buffer | null }>(
    'SELECT chunk_id, embedding FROM chunks WHERE memory_id = ? ORDER BY chunk_index ASC',
    [memoryId],
  );
  return rows.map(r => ({ chunkId: r.chunk_id, embedding: embeddingFromBuffer(r.embedding) }));
}

export async function listChunkIds(filter?: { memoryIds?: string[] }): Promise<string[]> {
  if (filter?.memoryIds && filter.memoryIds.length > 0) {
    const placeholders = filter.memoryIds.map(() => '?').join(',');
    const rows = await query<{ chunk_id: string }>(
      `SELECT chunk_id FROM chunks WHERE memory_id IN (${placeholders}) ORDER BY memory_id, chunk_index`,
      filter.memoryIds,
    );
    return rows.map(r => r.chunk_id);
  }
  const rows = await query<{ chunk_id: string }>('SELECT chunk_id FROM chunks ORDER BY memory_id, chunk_index');
  return rows.map(r => r.chunk_id);
}

export async function deleteChunksForMemory(memoryId: string): Promise<void> {
  await execute('DELETE FROM chunks WHERE memory_id = ?', [memoryId]);
}

export async function getChunkCount(): Promise<number> {
  const row = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM chunks');
  return row?.n ?? 0;
}

// Chunks left with embedding=null — either Ollama was offline at chunk time
// (chunkAndPersistMemory tolerates that) or the hook's wall-clock deadline
// was hit mid-batch before every chunk got embedded. Picked up by the
// daemon's embed-backfill on its regular timer.
export async function getChunksNeedingEmbedding(limit: number): Promise<{ chunk_id: string; text: string }[]> {
  return query<{ chunk_id: string; text: string }>(
    'SELECT chunk_id, text FROM chunks WHERE embedding IS NULL LIMIT ?',
    [limit],
  );
}

export async function setChunkEmbedding(chunkId: string, embedding: number[], model: string): Promise<void> {
  await execute(
    'UPDATE chunks SET embedding = ?, embedding_model = ? WHERE chunk_id = ?',
    [encodeEmbedding(embedding), model, chunkId],
  );
}

export function decodeChunkEmbedding(buf: Buffer | null): number[] | null {
  return embeddingFromBuffer(buf);
}

const LEXICAL_STOP = new Set(('the and for are but not you your with that this from have has had was were will would could should can how what when where why who which into about after before then than them they their there here just only also some any all one two use used using get got set run runs ran make made need want like please does live lives find found work works working').split(' '));

/**
 * Lexical lane for recall: ids of chunks that contain a RARE term of the query. Dense retrieval alone
 * can bury a chunk that names the exact term (e.g. "mosaic") under many loosely similar ones. A term
 * counts as rare when it appears in 1..maxChunksPerTerm chunks. Dual-dialect (LOWER + LIKE).
 */
export async function lexicalChunkIds(queryText: string, opts: { maxChunksPerTerm?: number } = {}): Promise<Set<string>> {
  const maxPer = opts.maxChunksPerTerm ?? 60;
  const terms = [...new Set((queryText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter(t => !LEXICAL_STOP.has(t)))].slice(0, 8);
  const out = new Set<string>();
  for (const t of terms) {
    const like = `%${t.replace(/[\\%_]/g, m => '\\' + m)}%`;
    const rows = await query<{ chunk_id: string }>(
      `SELECT chunk_id FROM chunks WHERE LOWER(text) LIKE ? ESCAPE '\\' LIMIT ${maxPer + 1}`, [like]);
    if (rows.length === 0 || rows.length > maxPer) continue; // absent or too common to discriminate
    for (const r of rows) out.add(r.chunk_id);
  }
  return out;
}
