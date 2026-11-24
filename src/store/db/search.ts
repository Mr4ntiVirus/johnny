import { query } from '../db-client.js';

export interface SearchResult {
  memoryId: string;
  snapshotName: string;
  title: string;
  summary: string | null;
  rank: number;
  retrievalCount: number;
  contentType: string;
}

export interface FullTextSearchOptions {
  query: string;
  limit?: number;
  contentType?: string;
}

export async function fullTextSearch(options: FullTextSearchOptions): Promise<SearchResult[]> {
  return simpleSearch(options.query, options.limit ?? 10);
}

async function simpleSearch(q: string, limit: number): Promise<SearchResult[]> {
  const pattern = `%${q}%`;
  const rows = await query<{
    id: string; snapshot_name: string; title: string; summary: string | null;
    rank: number; retrieval_count: number; content_type: string;
  }>(
    `SELECT m.id, m.snapshot_name, m.title, m.summary, m.rank, m.retrieval_count, m.content_type
     FROM memories m
     JOIN transcripts t ON m.id = t.memory_id
     WHERE m.title LIKE ? OR m.snapshot_name LIKE ? OR t.transcript LIKE ?
     ORDER BY m.rank DESC
     LIMIT ?`,
    [pattern, pattern, pattern, limit],
  );
  return rows.map(row => ({
    memoryId: row.id, snapshotName: row.snapshot_name, title: row.title,
    summary: row.summary, rank: row.rank, retrievalCount: row.retrieval_count, contentType: row.content_type,
  }));
}

// Search is a plain LIKE scan over title, slug and transcript (SQLite's LIKE is
// case-insensitive for ASCII), so there is no full-text index to rebuild. Kept as a
// stable entry point for callers.
export async function rebuildFTS(): Promise<{ added: number; errors: number }> {
  return { added: 0, errors: 0 };
}

export async function searchSkills(q: string, limit = 5): Promise<SearchResult[]> {
  return fullTextSearch({ query: q, limit, contentType: 'skill' });
}

export async function searchTools(q: string, limit = 5): Promise<SearchResult[]> {
  return fullTextSearch({ query: q, limit, contentType: 'tool' });
}

export async function getRecentMemories(limit = 10): Promise<SearchResult[]> {
  const rows = await query<{
    id: string; snapshot_name: string; title: string; summary: string | null;
    rank: number; retrieval_count: number; content_type: string;
  }>(
    `SELECT id, snapshot_name, title, summary, rank, retrieval_count, content_type
     FROM memories ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(row => ({
    memoryId: row.id, snapshotName: row.snapshot_name, title: row.title,
    summary: row.summary, rank: row.rank, retrievalCount: row.retrieval_count, contentType: row.content_type,
  }));
}
