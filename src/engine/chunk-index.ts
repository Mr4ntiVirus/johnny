// In-process chunk vector index for chunk-first recall.
//
// Why: johnny_recall used to preselect the top-8 MEMORIES by summary embedding
// and only then score their chunks. With thousands of near-identical summaries
// the 8 slots filled with clones, so the memory that actually held the answer
// was never examined (the "mosaic recall rerank synthesis" miss), and only the
// first 5,000 memories were even considered. Now every stored chunk vector is
// scored directly (after dedup there are ~15k unique chunks ≈ 60MB), with the
// memory graph rank as a mild prior.
//
// The index is cached per process and rebuilt when the chunk table changes
// (cheap COUNT/MAX signature, at most once per MIN_REBUILD_INTERVAL_MS).

import { query } from '../store/db-client.js';
import { decodeEmbedding } from '../utils/embedding-codec.js';

export interface IndexedChunk {
  chunkId: string;
  memoryId: string;
  tokenCount: number;
  vec: Float32Array; // L2-normalised
}

export interface MemoryMeta {
  id: string;
  name: string;
  rank: number;
  createdAt: string;
}

export interface ChunkHit {
  chunkId: string;
  memoryId: string;
  tokenCount: number;
  cosine: number;   // raw cosine similarity
  score: number;    // cosine × memory-rank prior (used for ordering only)
}

/** Above this many embedded chunks the index is skipped (store not yet deduped). */
export const MAX_INDEX_ROWS = 80_000;
const MIN_REBUILD_INTERVAL_MS = 30_000;
/** Rank prior strength: score = cosine × (1 + PRIOR_ALPHA × (rank/maxRank − 0.5)). */
export const PRIOR_ALPHA = 0.1;
/** Ordering bonus for chunks that contain a rare query term (hybrid lexical + dense). */
export const LEXICAL_BONUS = 0.12;
/** Candidates at least this cosine-similar to an already-chosen chunk are dropped from an answer. */
export const NEAR_DUP_COSINE = 0.97;

export function normalise(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export class ChunkIndex {
  constructor(
    public readonly entries: IndexedChunk[],
    public readonly memories: Map<string, MemoryMeta>,
    public readonly signature: string,
  ) {}

  get size(): number { return this.entries.length; }

  search(
    queryVec: number[], k: number,
    opts: { excludeChunkIds?: Set<string>; maxPerMemory?: number; nearDupCosine?: number; lexicalChunkIds?: Set<string> } = {},
  ): ChunkHit[] {
    const q = normalise(queryVec);
    let maxRank = 0;
    for (const m of this.memories.values()) if (m.rank > maxRank) maxRank = m.rank;
    maxRank = maxRank || 1;

    const scored: Array<ChunkHit & { vec: Float32Array }> = [];
    for (const e of this.entries) {
      if (e.vec.length !== q.length) continue; // different embedding model generation
      if (opts.excludeChunkIds?.has(e.chunkId)) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * e.vec[i];
      const rank = this.memories.get(e.memoryId)?.rank ?? 0;
      const prior = 1 + PRIOR_ALPHA * (rank / maxRank - 0.5);
      const bonus = opts.lexicalChunkIds?.has(e.chunkId) ? LEXICAL_BONUS : 0;
      scored.push({ chunkId: e.chunkId, memoryId: e.memoryId, tokenCount: e.tokenCount, cosine: dot, score: (dot + bonus) * prior, vec: e.vec });
    }
    scored.sort((a, b) => b.score - a.score);

    // Exact-hash dedup can't catch chunks that differ only by shifted boundaries or a
    // trailing line, so drop candidates that are near-identical to one already chosen.
    const nearDup = opts.nearDupCosine ?? NEAR_DUP_COSINE;
    const cap = opts.maxPerMemory ?? Infinity;
    const perMem = new Map<string, number>();
    const chosenVecs: Float32Array[] = [];
    const out: ChunkHit[] = [];
    for (const h of scored) {
      const n = perMem.get(h.memoryId) ?? 0;
      if (n >= cap) continue;
      let dup = false;
      for (const cv of chosenVecs) {
        let d = 0;
        for (let i = 0; i < cv.length; i++) d += cv[i] * h.vec[i];
        if (d >= nearDup) { dup = true; break; }
      }
      if (dup) continue;
      perMem.set(h.memoryId, n + 1);
      chosenVecs.push(h.vec);
      const { vec: _vec, ...hit } = h;
      out.push(hit);
      if (out.length >= k) break;
    }
    return out;
  }
}

interface ChunkRow { chunk_id: string; memory_id: string; token_count: number; embedding: Buffer }
interface MemRow { id: string; snapshot_name: string; rank: number; created_at: string }

let cached: ChunkIndex | null = null;
let lastCheck = 0;
let building: Promise<ChunkIndex | null> | null = null;

async function signature(): Promise<{ sig: string; embedded: number }> {
  const rows = await query<{ n: number; m: string | null; e: number }>(
    `SELECT COUNT(*) AS n, MAX(created_at) AS m,
            SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS e FROM chunks`);
  const r = rows[0];
  return { sig: `${Number(r?.n) || 0}|${r?.m ?? ''}|${Number(r?.e) || 0}`, embedded: Number(r?.e) || 0 };
}

async function build(sig: string): Promise<ChunkIndex> {
  const chunkRows = await query<ChunkRow>(
    `SELECT c.chunk_id, c.memory_id, c.token_count, c.embedding
     FROM chunks c JOIN memories m ON m.id = c.memory_id
     WHERE c.embedding IS NOT NULL AND m.valid_to IS NULL AND COALESCE(m.content_type, 'text') != 'schema'`);
  const entries: IndexedChunk[] = [];
  for (const r of chunkRows) {
    try {
      entries.push({
        chunkId: r.chunk_id, memoryId: r.memory_id, tokenCount: r.token_count,
        vec: normalise(decodeEmbedding(r.embedding)),
      });
    } catch { /* corrupt embedding blob: skip */ }
  }
  const memRows = await query<MemRow>('SELECT id, snapshot_name, rank, created_at FROM memories');
  const memories = new Map<string, MemoryMeta>();
  for (const m of memRows) memories.set(m.id, { id: m.id, name: m.snapshot_name, rank: Number(m.rank) || 0, createdAt: m.created_at });
  return new ChunkIndex(entries, memories, sig);
}

/**
 * Cached index, or null when the store is too large to index (not yet
 * deduplicated) or empty — callers fall back to the legacy memory-first path.
 */
export async function getChunkIndex(opts: { force?: boolean } = {}): Promise<ChunkIndex | null> {
  const now = Date.now();
  if (!opts.force && cached && now - lastCheck < MIN_REBUILD_INTERVAL_MS) return cached;
  if (building) return building;
  building = (async () => {
    try {
      const { sig, embedded } = await signature();
      lastCheck = Date.now();
      if (embedded === 0 || embedded > MAX_INDEX_ROWS) { cached = null; return null; }
      if (cached && cached.signature === sig) return cached;
      cached = await build(sig);
      return cached;
    } finally {
      building = null;
    }
  })();
  return building;
}

export function resetChunkIndexCache(): void {
  cached = null;
  lastCheck = 0;
  building = null;
}
