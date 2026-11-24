import { query, queryOne, execute } from '../db-client.js';

export type EdgeType = 'co_retrieval' | 'derived_from' | 'semantic_similarity' | 'skill_link';

export interface EdgeInput {
  sourceId: string;
  targetId: string;
  weight?: number;
  createdAtTurn?: number;
  edgeType?: EdgeType;
}

export interface EdgeRecord {
  id: number;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  weight: number;
  co_retrieval_count: number;
  invalidation_count: number;
  last_reinforced_turn: number | null;
  last_reinforced_at: string | null;
  last_invalidated_turn: number | null;
  created_at: string;
  created_at_turn: number | null;
}

export interface MemoryEdges {
  incoming: EdgeRecord[];
  outgoing: EdgeRecord[];
}

export async function createEdge(input: EdgeInput): Promise<void> {
  await execute(
    `INSERT INTO edges (source_id, target_id, edge_type, weight, created_at, created_at_turn) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.sourceId, input.targetId, input.edgeType ?? 'co_retrieval', input.weight ?? 0.15, new Date().toISOString(), input.createdAtTurn ?? null],
  );
}

// Deletes the weakest outgoing edges for a single source_id beyond `cap`.
// Scoped to one source_id (indexed, cheap) — unlike pruneOutgoingEdgesOverCap's
// global sweep, safe to call inline on every write.
async function capOutgoingEdgesFor(sourceId: string, cap: number): Promise<void> {
  await execute(
    `DELETE FROM edges WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY weight DESC, id ASC) AS rn
         FROM edges WHERE source_id = ?
       ) ranked
       WHERE rn > ?
     )`,
    [sourceId, cap],
  );
}

export async function createDerivedFromEdges(childId: string, parentIds: string[], turn: number, weight: number, topK: number): Promise<void> {
  if (parentIds.length === 0) return;
  const now = new Date().toISOString();
  // Neither MAX() (aggregate-only in most SQL) nor GREATEST() is a 2-arg scalar in
  // SQLite, so use a CASE expression.
  const sql = `
    INSERT INTO edges (source_id, target_id, edge_type, weight, created_at, created_at_turn)
    VALUES (?, ?, 'derived_from', ?, ?, ?)
    ON CONFLICT(source_id, target_id) DO UPDATE SET
      edge_type = 'derived_from',
      weight = CASE WHEN excluded.weight > edges.weight THEN excluded.weight ELSE edges.weight END`;
  // Unlike reinforceEdge() (in-memory graph.ts, evicts as part of the loaded
  // graph object), this writes raw SQL with no graph in memory — nothing else
  // enforces topKOutgoing here, so without capOutgoingEdgesFor a hub memory's
  // edge count grows unbounded (confirmed in production: some memories had
  // 1000+ outgoing edges against a configured cap of 50).
  const touchedSources = new Set<string>();
  for (const parentId of parentIds) {
    if (parentId === childId) continue;
    await execute(sql, [childId, parentId, weight, now, turn]);
    await execute(sql, [parentId, childId, weight, now, turn]);
    touchedSources.add(childId);
    touchedSources.add(parentId);
  }
  for (const sourceId of touchedSources) {
    await capOutgoingEdgesFor(sourceId, topK);
  }
}

export async function getEdge(sourceId: string, targetId: string): Promise<EdgeRecord | null> {
  return queryOne<EdgeRecord>('SELECT * FROM edges WHERE source_id = ? AND target_id = ?', [sourceId, targetId]);
}

export async function getOutgoingEdges(memoryId: string): Promise<EdgeRecord[]> {
  return query<EdgeRecord>('SELECT * FROM edges WHERE source_id = ? ORDER BY weight DESC', [memoryId]);
}

export async function getIncomingEdges(memoryId: string): Promise<EdgeRecord[]> {
  return query<EdgeRecord>('SELECT * FROM edges WHERE target_id = ? ORDER BY weight DESC', [memoryId]);
}

export async function getAllEdgesFor(memoryId: string): Promise<MemoryEdges> {
  const [incoming, outgoing] = await Promise.all([getIncomingEdges(memoryId), getOutgoingEdges(memoryId)]);
  return { incoming, outgoing };
}

export async function edgeExists(sourceId: string, targetId: string): Promise<boolean> {
  const row = await queryOne<{ r: number }>('SELECT 1 AS r FROM edges WHERE source_id = ? AND target_id = ? LIMIT 1', [sourceId, targetId]);
  return !!row;
}

export async function reinforceEdge(sourceId: string, targetId: string, delta: number = 0.1, turn: number): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getEdge(sourceId, targetId);
  if (existing) {
    await execute(
      `UPDATE edges SET weight = weight + ?, co_retrieval_count = co_retrieval_count + 1, last_reinforced_turn = ?, last_reinforced_at = ? WHERE source_id = ? AND target_id = ?`,
      [delta, turn, now, sourceId, targetId],
    );
  } else {
    await execute(
      `INSERT INTO edges (source_id, target_id, weight, co_retrieval_count, last_reinforced_turn, last_reinforced_at, created_at, created_at_turn) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [sourceId, targetId, delta, turn, now, now, turn],
    );
  }
}

export async function invalidateEdge(sourceId: string, targetId: string, turn: number): Promise<void> {
  await execute(
    `UPDATE edges SET invalidation_count = invalidation_count + 1, last_invalidated_turn = ? WHERE source_id = ? AND target_id = ?`,
    [turn, sourceId, targetId],
  );
}

export async function deleteEdge(sourceId: string, targetId: string): Promise<void> {
  await execute('DELETE FROM edges WHERE source_id = ? AND target_id = ?', [sourceId, targetId]);
}

export async function pruneWeakEdges(threshold = 0.01): Promise<number> {
  const rows = await query<{ count: number }>(
    `DELETE FROM edges WHERE weight < ? AND edge_type != 'derived_from' RETURNING 1`,
    [threshold],
  );
  return rows.length;
}

export async function getTotalEdgeCount(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM edges');
  return row?.count ?? 0;
}

// Single-query bulk load for graph hydration — avoids N round-trips.
// `limit` bounds the interactive hook/CLI path (which then does a synchronous
// JS pass over every row) against unbounded growth — at ~530K edges this was
// taking minutes of CPU-bound iteration on a 1-vCPU Fargate task, well past
// Claude Code's 30s hook timeout, even though the same code ran in seconds on
// faster hardware. Already sorted by weight, so a LIMIT keeps the
// highest-signal edges. Omit `limit` (as PageRank/consolidation callers do)
// to get the full, correct edge set for offline/batch graph analysis.
export async function getAllEdges(limit?: number): Promise<EdgeRecord[]> {
  if (limit === undefined) {
    return query<EdgeRecord>('SELECT * FROM edges ORDER BY weight DESC');
  }
  return query<EdgeRecord>('SELECT * FROM edges ORDER BY weight DESC LIMIT ?', [limit]);
}

export async function getEdgesForMemories(memoryIds: string[]): Promise<EdgeRecord[]> {
  if (memoryIds.length === 0) return [];
  const placeholders = memoryIds.map(() => '?').join(',');
  return query<EdgeRecord>(
    `SELECT * FROM edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    [...memoryIds, ...memoryIds],
  );
}

export async function getConnectedMemories(memoryId: string): Promise<string[]> {
  const rows = await query<{ connected_id: string }>(
    `SELECT DISTINCT CASE WHEN source_id = ? THEN target_id ELSE source_id END as connected_id
     FROM edges WHERE source_id = ? OR target_id = ?`,
    [memoryId, memoryId, memoryId],
  );
  return rows.map(r => r.connected_id);
}

export async function getEdgeStats(): Promise<{ totalEdges: number; avgWeight: number; weakestEdge: EdgeRecord | null }> {
  const [countRow, avgRow, weakRow] = await Promise.all([
    queryOne<{ count: number }>('SELECT COUNT(*) as count FROM edges'),
    queryOne<{ avg: number | null }>('SELECT AVG(weight) as avg FROM edges'),
    queryOne<EdgeRecord>('SELECT * FROM edges ORDER BY weight ASC LIMIT 1'),
  ]);
  return { totalEdges: countRow?.count ?? 0, avgWeight: avgRow?.avg ?? 0, weakestEdge: weakRow ?? null };
}

export async function updateEdgeWeight(sourceId: string, targetId: string, newWeight: number): Promise<void> {
  await execute('UPDATE edges SET weight = ? WHERE source_id = ? AND target_id = ?', [newWeight, sourceId, targetId]);
}

export async function getTopEdgesByWeight(limit = 10): Promise<EdgeRecord[]> {
  return query<EdgeRecord>('SELECT * FROM edges ORDER BY weight DESC LIMIT ?', [limit]);
}

// One-time backfill: for each source_id, delete all but the top-`cap`
// outgoing edges by weight (ties broken by id for determinism/idempotency).
// Returns the number of deleted rows.
export async function rescaleAllEdgeWeights(scale: number): Promise<void> {
  await execute(`UPDATE edges SET weight = weight * ? WHERE edge_type != 'derived_from'`, [scale]);
}

export async function pruneOutgoingEdgesOverCap(cap: number): Promise<number> {
  const rows = await query<{ id: number }>(
    `DELETE FROM edges
     WHERE id IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY weight DESC, id ASC) AS rn
         FROM edges
       ) ranked
       WHERE rn > ?
     )
     RETURNING id`,
    [cap],
  );
  return rows.length;
}

export async function countOutgoingEdgesOverCap(cap: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM (
       SELECT ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY weight DESC, id ASC) AS rn
       FROM edges
     ) ranked
     WHERE rn > ?`,
    [cap],
  );
  return row?.count ?? 0;
}
