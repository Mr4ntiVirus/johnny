// Duplicate-chunk purge (Phase 0.2).
//
// Background: ~83% of stored chunks were verbatim copies because snapshots
// kept re-capturing already-captured history (trim cursor reset + resumed
// sessions). The write path is fixed (snapshot-delta.ts + chunker write-time
// dedup); this module cleans up the historical damage.
//
// Rules:
//   * Canonical copy of a chunk = the one in the EARLIEST memory (ties: chunk_id).
//   * Duplicate chunk rows are deleted. A memory left with no chunk of its own
//     (it only ever held copies) is purged, after its graph edges are merged into
//     the memory that owns most of its canonical chunks — rank/Hebbian signal is
//     preserved rather than lost.
//   * SQLite via db-client. Re-runnable:
//     every step is idempotent, so an interrupted run can simply be repeated.

import { query, execute } from '../store/db-client.js';
import { contentHash } from '../utils/content-hash.js';

const IN_BATCH = 400;

export interface DedupePlan {
  totalChunks: number;
  distinctHashes: number;
  duplicateChunkIds: string[];
  /** memoryId → canonical memoryId, for memories that only held duplicate chunks. */
  purge: Record<string, string>;
  /** Memories that keep at least one chunk of their own. */
  keptMemories: number;
}

export interface DedupeResult {
  deletedChunks: number;
  purgedMemories: number;
  mergedEdges: number;
  droppedEdges: number;
}

export interface Verification {
  chunks: number;
  distinctChunkTexts: number;
  chunksMissingHash: number;
  memories: number;
  orphanEdges: number;
  danglingActiveMemory: number;
}

const batches = <T>(items: T[], n = IN_BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};
const qs = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Compute and store content_hash for chunks that lack one. Returns rows updated. */
export async function backfillHashes(onProgress?: (done: number) => void): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await query<{ chunk_id: string; text: string }>(
      'SELECT chunk_id, text FROM chunks WHERE content_hash IS NULL LIMIT 2000');
    if (rows.length === 0) break;
    // Row-at-a-time updates are cheap on the local SQLite store.
    for (const r of rows) {
      await execute('UPDATE chunks SET content_hash = ? WHERE chunk_id = ?', [contentHash(r.text), r.chunk_id]);
    }
    total += rows.length;
    onProgress?.(total);
  }
  return total;
}

export async function planDedupe(): Promise<DedupePlan> {
  const rows = await query<{ chunk_id: string; memory_id: string; content_hash: string }>(
    `SELECT c.chunk_id, c.memory_id, c.content_hash
     FROM chunks c JOIN memories m ON m.id = c.memory_id
     WHERE c.content_hash IS NOT NULL
     ORDER BY c.content_hash, m.created_at, c.chunk_id`);

  const canonicalMemoryByHash = new Map<string, string>();
  const duplicateChunkIds: string[] = [];
  const totalByMemory = new Map<string, number>();
  const keptByMemory = new Map<string, number>();
  const dupOwnerCanon = new Map<string, Map<string, number>>(); // memory → canonical memory → count

  for (const r of rows) {
    totalByMemory.set(r.memory_id, (totalByMemory.get(r.memory_id) ?? 0) + 1);
    const canon = canonicalMemoryByHash.get(r.content_hash);
    if (canon === undefined) {
      canonicalMemoryByHash.set(r.content_hash, r.memory_id);
      keptByMemory.set(r.memory_id, (keptByMemory.get(r.memory_id) ?? 0) + 1);
    } else {
      duplicateChunkIds.push(r.chunk_id);
      if (canon !== r.memory_id) {
        const m = dupOwnerCanon.get(r.memory_id) ?? new Map<string, number>();
        m.set(canon, (m.get(canon) ?? 0) + 1);
        dupOwnerCanon.set(r.memory_id, m);
      }
    }
  }

  const purge: Record<string, string> = {};
  for (const [memoryId, total] of totalByMemory) {
    if (total > 0 && (keptByMemory.get(memoryId) ?? 0) === 0) {
      const votes = dupOwnerCanon.get(memoryId);
      let best: string | null = null;
      let bestN = -1;
      if (votes) for (const [c, n] of votes) if (n > bestN) { best = c; bestN = n; }
      // Fall back to itself only if no other owner exists (cannot happen when
      // total>0 && kept===0, but stay defensive): such a memory is not purged.
      if (best) purge[memoryId] = best;
    }
  }

  return {
    totalChunks: rows.length,
    distinctHashes: canonicalMemoryByHash.size,
    duplicateChunkIds,
    purge,
    keptMemories: new Set([...keptByMemory.keys()]).size,
  };
}

interface EdgeRow {
  source_id: string; target_id: string; weight: number; co_retrieval_count: number;
  invalidation_count: number; last_reinforced_turn: number | null; last_invalidated_turn: number | null;
  edge_type: string | null;
}

/**
 * Merge graph edges of purged memories into their canonical memories, then
 * delete the purged memories (and everything that cascades from them).
 */
export async function purgeMemories(
  mapping: Record<string, string>,
  onProgress?: (msg: string) => void,
): Promise<{ purgedMemories: number; mergedEdges: number; droppedEdges: number }> {
  const purgedIds = new Set(Object.keys(mapping));
  if (purgedIds.size === 0) return { purgedMemories: 0, mergedEdges: 0, droppedEdges: 0 };

  // Resolve chains defensively (canonical of a canonical) — canonical memories are never purged
  // by construction.
  const resolve = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 10 && purgedIds.has(cur); i++) cur = mapping[cur];
    return cur;
  };

  // 1) Merge edges. Load every edge touching a purged memory.
  const touching: EdgeRow[] = [];
  const idList = [...purgedIds];
  for (const b of batches(idList)) {
    const rows = await query<EdgeRow>(
      `SELECT source_id, target_id, weight, co_retrieval_count, invalidation_count,
              last_reinforced_turn, last_invalidated_turn, edge_type
       FROM edges WHERE source_id IN (${qs(b.length)}) OR target_id IN (${qs(b.length)})`,
      [...b, ...b]);
    touching.push(...rows);
  }
  const merged = new Map<string, EdgeRow>();
  let dropped = 0;
  for (const e of touching) {
    const s = resolve(e.source_id);
    const t = resolve(e.target_id);
    if (s === t) { dropped++; continue; }
    const key = `${s}\u0000${t}`;
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...e, source_id: s, target_id: t });
    } else {
      cur.weight = Math.max(cur.weight, e.weight);
      cur.co_retrieval_count += e.co_retrieval_count;
      cur.invalidation_count += e.invalidation_count;
      cur.last_reinforced_turn = Math.max(cur.last_reinforced_turn ?? 0, e.last_reinforced_turn ?? 0) || null;
      cur.last_invalidated_turn = Math.max(cur.last_invalidated_turn ?? 0, e.last_invalidated_turn ?? 0) || null;
      if (e.edge_type === 'derived_from') cur.edge_type = 'derived_from';
    }
  }
  const nowIso = new Date().toISOString();
  let mergedCount = 0;
  const merged_ = [...merged.values()];
  const EDGE_BATCH = 80; // 10 params per row, stays under SQLite's 999-variable limit
  for (let i = 0; i < merged_.length; i += EDGE_BATCH) {
    const slice = merged_.slice(i, i + EDGE_BATCH);
    const params: unknown[] = [];
    for (const e of slice) {
      params.push(e.source_id, e.target_id, e.weight, e.co_retrieval_count, e.invalidation_count,
        e.last_reinforced_turn, nowIso, e.last_invalidated_turn, nowIso, e.edge_type ?? 'co_retrieval');
    }
    // Weight/count conflict resolution without GREATEST/MAX(a,b) (dual-dialect).
    await execute(
      `INSERT INTO edges (source_id, target_id, weight, co_retrieval_count, invalidation_count,
                          last_reinforced_turn, last_reinforced_at, last_invalidated_turn, created_at, edge_type)
       VALUES ${slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',')}
       ON CONFLICT (source_id, target_id) DO UPDATE SET
         weight = CASE WHEN excluded.weight > edges.weight THEN excluded.weight ELSE edges.weight END,
         co_retrieval_count = edges.co_retrieval_count + excluded.co_retrieval_count,
         invalidation_count = edges.invalidation_count + excluded.invalidation_count,
         last_reinforced_at = excluded.last_reinforced_at,
         edge_type = CASE WHEN excluded.edge_type = 'derived_from' THEN 'derived_from' ELSE edges.edge_type END`,
      params);
    mergedCount += slice.length;
  }
  onProgress?.(`edges: merged ${mergedCount}, dropped ${dropped} self-loops`);

  // 2) Clear references that have no ON DELETE action.
  for (const b of batches(idList)) {
    await execute(`UPDATE sessions SET active_memory_id = NULL WHERE active_memory_id IN (${qs(b.length)})`, b);
    await execute(`UPDATE snapshot_ledger SET memory_id = NULL WHERE memory_id IN (${qs(b.length)})`, b);
  }
  const sessions = await query<{ session_id: string; surfaced_memories: string | null; recalled_memory_ids: string | null }>(
    'SELECT session_id, surfaced_memories, recalled_memory_ids FROM sessions');
  for (const s of sessions) {
    const fix = (raw: string | null): string | null | undefined => {
      if (!raw) return undefined;
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) {
          const next = v.filter((id: unknown) => !purgedIds.has(String(id)));
          return next.length === v.length ? undefined : JSON.stringify(next);
        }
        if (v && typeof v === 'object') {
          const next = Object.fromEntries(Object.entries(v).filter(([id]) => !purgedIds.has(id)));
          return Object.keys(next).length === Object.keys(v).length ? undefined : JSON.stringify(next);
        }
      } catch { /* leave malformed value alone */ }
      return undefined;
    };
    const sm = fix(s.surfaced_memories);
    const rm = fix(s.recalled_memory_ids);
    if (sm !== undefined) await execute('UPDATE sessions SET surfaced_memories = ? WHERE session_id = ?', [sm, s.session_id]);
    if (rm !== undefined) await execute('UPDATE sessions SET recalled_memory_ids = ? WHERE session_id = ?', [rm, s.session_id]);
  }

  // 3) Delete purged memories (cascades transcripts, chunks, remaining edges).
  let purged = 0;
  for (const b of batches(idList, 200)) {
    await execute(`DELETE FROM memories WHERE id IN (${qs(b.length)})`, b);
    purged += b.length;
    if (purged % 2000 < 200) onProgress?.(`memories: purged ${purged}/${idList.length}`);
  }
  return { purgedMemories: purged, mergedEdges: mergedCount, droppedEdges: dropped };
}

export async function applyDedupe(plan: DedupePlan, onProgress?: (msg: string) => void): Promise<DedupeResult> {
  // Duplicate chunk rows first (cheap, independent of memory purge).
  let deleted = 0;
  for (const b of batches(plan.duplicateChunkIds)) {
    await execute(`DELETE FROM chunks WHERE chunk_id IN (${qs(b.length)})`, b);
    deleted += b.length;
    if (deleted % 20000 < IN_BATCH) onProgress?.(`chunks: deleted ${deleted}/${plan.duplicateChunkIds.length}`);
  }
  const p = await purgeMemories(plan.purge, onProgress);
  return { deletedChunks: deleted, ...p };
}

export async function verifyDedupe(): Promise<Verification> {
  const one = async (sql: string): Promise<number> => {
    const r = await query<{ n: number }>(sql);
    return Number(r[0]?.n) || 0;
  };
  return {
    chunks: await one('SELECT COUNT(*) AS n FROM chunks'),
    distinctChunkTexts: await one('SELECT COUNT(DISTINCT content_hash) AS n FROM chunks WHERE content_hash IS NOT NULL'),
    chunksMissingHash: await one('SELECT COUNT(*) AS n FROM chunks WHERE content_hash IS NULL'),
    memories: await one('SELECT COUNT(*) AS n FROM memories'),
    orphanEdges: await one(
      `SELECT COUNT(*) AS n FROM edges e
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_id)
          OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.target_id)`),
    danglingActiveMemory: await one(
      `SELECT COUNT(*) AS n FROM sessions s
       WHERE s.active_memory_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = s.active_memory_id)`),
  };
}

/** Post-apply invariants; returns a list of human-readable problems (empty = healthy). */
export function checkInvariants(v: Verification): string[] {
  const problems: string[] = [];
  if (v.chunksMissingHash > 0) problems.push(`${v.chunksMissingHash} chunks still lack a content hash`);
  if (v.chunks !== v.distinctChunkTexts + v.chunksMissingHash) {
    problems.push(`duplicates remain: ${v.chunks} chunks vs ${v.distinctChunkTexts} distinct texts`);
  }
  if (v.orphanEdges > 0) problems.push(`${v.orphanEdges} orphan edges`);
  if (v.danglingActiveMemory > 0) problems.push(`${v.danglingActiveMemory} sessions point at deleted memories`);
  return problems;
}


/**
 * Standing sweep (run by the synthesis heartbeat): delete duplicate CHUNK rows only.
 * Deliberately never purges memories — memory deletes don't propagate through
 * sync (no tombstones) and could be resurrected; the write-time guard makes new
 * duplicates rare, and this catches stragglers (e.g. races between two hooks).
 * Chunk rows are never synced, so removing them is always safe.
 */
export async function sweepDuplicateChunks(): Promise<{ hashed: number; deleted: number }> {
  const hashed = await backfillHashes();
  const dup = await query<{ n: number }>(
    `SELECT COUNT(*) - COUNT(DISTINCT content_hash) AS n FROM chunks WHERE content_hash IS NOT NULL`);
  if ((Number(dup[0]?.n) || 0) <= 0) return { hashed, deleted: 0 };
  const plan = await planDedupe();
  let deleted = 0;
  for (const b of batches(plan.duplicateChunkIds)) {
    await execute(`DELETE FROM chunks WHERE chunk_id IN (${qs(b.length)})`, b);
    deleted += b.length;
  }
  return { hashed, deleted };
}
