import { query, queryOne, execute } from '../db-client.js';
import { randomUUID } from 'node:crypto';
import type { ContentType } from '../database.js';

export interface MemoryInput {
  id?: string;
  snapshotName: string;
  title: string;
  summary?: string;
  contentType?: ContentType;
  projectPath?: string;
  sourceUri?: string;
  tokenCount?: number;
  createdAtTurn?: number;
}

export interface MemoryRecord {
  id: string;
  snapshot_name: string;
  title: string;
  summary: string | null;
  content_type: string;
  project_path: string | null;
  source_uri: string | null;
  token_count: number;
  retrieval_count: number;
  rank: number;
  created_at: string;
  created_at_turn: number | null;
  last_retrieved_turn: number | null;
  last_retrieved_at: string | null;
}

export interface ListMemoriesOptions {
  contentType?: ContentType;
  projectPath?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'rank' | 'created_at' | 'retrieval_count';
  // Set true to include quarantined schema gist nodes. Default: false (excluded
  // from all recall, MCP search, bootstrap, and graph loads until approved).
  includeSchemas?: boolean;
  // Set true to include memories replaced via johnny_remember({supersedes}).
  // Default: false — superseded memories are kept as history but never recalled.
  includeSuperseded?: boolean;
}

export interface MemoryWithTranscript extends MemoryRecord {
  transcript: string | null;
  topics: string[];
  embedding: number[] | null;
}

// Explicit column list — never `SELECT *`. `memories.fts_vector` is a tsvector
// built from title+summary+full transcript+topics (see db/search.ts rebuildFTS);
// it's write-only (search.ts matches via ILIKE, nothing queries `fts_vector @@ ...`)
// but dragging it along on every row made a plain listMemories() read take
// 10-14s on a slow database — enough to blow the hook's 30s
// budget on its own, independent of row count or edge volume.
const MEMORY_COLUMNS = `id, snapshot_name, title, summary, content_type, project_path,
  source_uri, token_count, retrieval_count, rank, created_at, created_at_turn,
  last_retrieved_turn, last_retrieved_at`;

export async function createMemory(input: MemoryInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await execute(
    `INSERT INTO memories
       (id, snapshot_name, title, summary, content_type, project_path, source_uri, token_count, created_at, created_at_turn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.snapshotName, input.title, input.summary ?? null, input.contentType ?? 'text',
     input.projectPath ?? null, input.sourceUri ?? null, input.tokenCount ?? 0,
     new Date().toISOString(), input.createdAtTurn ?? null],
  );
  return id;
}

export async function getMemory(id: string): Promise<MemoryRecord | null> {
  return queryOne<MemoryRecord>(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`, [id]);
}

export async function getMemoryBySnapshot(snapshotName: string): Promise<MemoryRecord | null> {
  return queryOne<MemoryRecord>(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE snapshot_name = ?`, [snapshotName]);
}

export async function listMemories(options: ListMemoriesOptions = {}): Promise<MemoryRecord[]> {
  const { contentType, projectPath, limit = 50, offset = 0, orderBy = 'rank', includeSchemas = false, includeSuperseded = false } = options;
  let sql = `SELECT ${MEMORY_COLUMNS} FROM memories WHERE 1=1`;
  const params: (string | number)[] = [];

  if (contentType) {
    sql += ' AND content_type = ?';
    params.push(contentType);
  } else if (!includeSchemas) {
    // Quarantined schema gist nodes are excluded from all automatic surfaces
    // (recall, MCP, bootstrap, graph load) until approved via `johnny schemas approve`.
    sql += " AND content_type != 'schema'";
  }
  if (!includeSuperseded) sql += ' AND valid_to IS NULL';
  if (projectPath) { sql += ' AND project_path = ?'; params.push(projectPath); }

  const orderColumn = { rank: 'rank DESC', created_at: 'created_at DESC', retrieval_count: 'retrieval_count DESC' }[orderBy];
  sql += ` ORDER BY ${orderColumn} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return query<MemoryRecord>(sql, params);
}

export async function listSchemas(): Promise<MemoryRecord[]> {
  return query<MemoryRecord>(
    `SELECT ${MEMORY_COLUMNS} FROM memories WHERE content_type = 'schema' ORDER BY created_at DESC`,
  );
}

export async function approveSchema(id: string): Promise<boolean> {
  await execute("UPDATE memories SET content_type = 'text' WHERE id = ? AND content_type = 'schema'", [id]);
  return true;
}

export async function rejectSchema(id: string): Promise<boolean> {
  await execute("DELETE FROM memories WHERE id = ? AND content_type = 'schema'", [id]);
  return true;
}

export async function getMemoryCount(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM memories');
  return row?.count ?? 0;
}

export async function listMemoriesForDisplay(limit: number): Promise<MemoryRecord[]> {
  return query<MemoryRecord>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
     ORDER BY retrieval_count DESC, last_retrieved_at DESC, created_at DESC
     LIMIT ?`,
    [limit],
  );
}

export async function getTopMemoriesByRank(limit = 10): Promise<MemoryRecord[]> {
  return query<MemoryRecord>(`SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY rank DESC LIMIT ?`, [limit]);
}

export async function updateMemoryRank(id: string, rank: number, turn: number): Promise<void> {
  await execute('UPDATE memories SET rank = ?, last_retrieved_turn = ? WHERE id = ?', [rank, turn, id]);
}

export async function bulkUpdateMemoryRanks(updates: Array<{ id: string; rank: number; turn: number }>): Promise<void> {
  if (updates.length === 0) return;
  // Only update rank — never touch last_retrieved_turn here.
  // last_retrieved_turn tracks actual user recalls (recordRetrieval), not rank computations.
  for (const u of updates) await execute('UPDATE memories SET rank = ? WHERE id = ?', [u.rank, u.id]);
}

export async function recordRetrieval(id: string, turn: number): Promise<void> {
  await execute(
    `UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_turn = ?, last_retrieved_at = ? WHERE id = ?`,
    [turn, new Date().toISOString(), id],
  );
}

/**
 * Mark a memory superseded by a newer one: it is kept (never deleted) but
 * excluded from listings/recall. Reversible by clearing valid_to/superseded_by.
 */
export async function supersedeMemory(oldId: string, newId: string): Promise<void> {
  await execute('UPDATE memories SET superseded_by = ?, valid_to = ? WHERE id = ?', [newId, new Date().toISOString(), oldId]);
}

export async function deleteMemory(id: string): Promise<void> {
  await execute('DELETE FROM memories WHERE id = ?', [id]);
}

export async function memoryExists(snapshotName: string): Promise<boolean> {
  const row = await queryOne<{ r: number }>('SELECT 1 AS r FROM memories WHERE snapshot_name = ? LIMIT 1', [snapshotName]);
  return !!row;
}
