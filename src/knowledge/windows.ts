// Extraction windows: consecutive chunks of one memory grouped to ~1,200
// tokens (a 300-token chunk is too small and often cuts mid-turn). Windows are
// keyed by the hash of their chunk hashes, so identical content is extracted
// exactly once no matter how many memories contain it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query, execute } from '../store/db-client.js';
import { contentHash, combineHashes, normalizeForHash } from '../utils/content-hash.js';

export const WINDOW_TARGET_CHARS = 4800; // ~1,200 tokens at chars/4
export const MIN_WINDOW_CHARS = 200;
const MIN_USEFUL_RATIO = 0.25;

export interface ExtractWindow {
  hash: string;
  memoryId: string;
  chunkIds: string[];
  text: string;
}

export interface PendingMemory {
  id: string;
  snapshot_name: string;
  title: string;
  project_path: string | null;
  source_uri: string | null;
  created_at: string;
  rank: number;
}

const gitRootCache = new Map<string, string>();

const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'cdk.json', 'Gemfile', 'pom.xml'];
const MAX_MARKER_CLIMB = 3;

/**
 * Project scope = git root of the project path; failing that the nearest ancestor (within a few
 * levels, never above $HOME) carrying a project marker file; else the path itself; else 'global'.
 * The marker climb stops sub-directories of a non-git project (e.g. `app/bin`, `app/jobs.d`)
 * from fragmenting into tiny scopes of their own.
 */
export function scopeForProject(projectPath: string | null | undefined): string {
  const p = (projectPath ?? '').trim().replace(/\/+$/, '');
  if (!p) return 'global';
  const cached = gitRootCache.get(p);
  if (cached) return cached;
  const home = os.homedir();
  let result = p;
  let found = false;
  let dir = p;
  for (let i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) { result = dir; found = true; break; } } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!found) {
    dir = p;
    for (let i = 0; i <= MAX_MARKER_CLIMB && dir !== home && dir !== path.dirname(dir); i++) {
      try {
        if (PROJECT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) { result = dir; break; }
      } catch { /* ignore */ }
      dir = path.dirname(dir);
    }
  }
  gitRootCache.set(p, result);
  return result;
}

/** Fraction of characters that are NOT tool-call/result marker lines. */
export function usefulRatio(text: string): number {
  if (!text) return 0;
  let useful = 0;
  for (const line of text.split('\n')) {
    if (/^\s*\[tool( result)?[:\]]/i.test(line) || /^\s*\[Trimmed tool result/i.test(line)) continue;
    useful += line.length + 1;
  }
  return useful / (text.length || 1);
}

export function isWorthExtracting(text: string): boolean {
  return normalizeForHash(text).length >= MIN_WINDOW_CHARS && usefulRatio(text) >= MIN_USEFUL_RATIO;
}

interface ChunkRow { chunk_id: string; text: string; content_hash: string | null }

export async function buildWindowsForMemory(memoryId: string): Promise<ExtractWindow[]> {
  const chunks = await query<ChunkRow>(
    'SELECT chunk_id, text, content_hash FROM chunks WHERE memory_id = ? ORDER BY chunk_index ASC', [memoryId]);
  const windows: ExtractWindow[] = [];
  let cur: ChunkRow[] = [];
  let curLen = 0;

  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.map(c => c.text).join('\n');
    if (isWorthExtracting(text)) {
      windows.push({
        hash: combineHashes(cur.map(c => c.content_hash ?? contentHash(c.text))),
        memoryId,
        chunkIds: cur.map(c => c.chunk_id),
        text,
      });
    }
    cur = [];
    curLen = 0;
  };

  for (const c of chunks) {
    if (curLen + c.text.length > WINDOW_TARGET_CHARS && cur.length > 0) flush();
    cur.push(c);
    curLen += c.text.length + 1;
  }
  flush();
  return windows;
}

/** Memories with chunks whose extraction has not been marked done at this version, newest first. */
export async function selectPendingMemories(version: string, limit: number, excludeIds: string[] = []): Promise<PendingMemory[]> {
  const exclude = excludeIds.length > 0 ? `AND m.id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
  return query<PendingMemory>(
    `SELECT m.id, m.snapshot_name, m.title, m.project_path, m.source_uri, m.created_at, m.rank
     FROM memories m
     WHERE COALESCE(m.content_type, 'text') != 'schema'
       AND m.valid_to IS NULL
       AND EXISTS (SELECT 1 FROM chunks c WHERE c.memory_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM extraction_log l
         WHERE l.window_hash = 'mem:' || m.id AND l.extractor_version = ?)
       ${exclude}
     ORDER BY CASE WHEN m.created_at_turn = 0 AND m.source_uri IS NULL THEN 0 ELSE 1 END, m.created_at DESC
     LIMIT ?`,
    [version, ...excludeIds, limit]);
}

export async function countPendingMemories(version: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memories m
     WHERE COALESCE(m.content_type, 'text') != 'schema'
       AND m.valid_to IS NULL
       AND EXISTS (SELECT 1 FROM chunks c WHERE c.memory_id = m.id)
       AND NOT EXISTS (
         SELECT 1 FROM extraction_log l
         WHERE l.window_hash = 'mem:' || m.id AND l.extractor_version = ?)`, [version]);
  return Number(rows[0]?.n) || 0;
}

export async function markMemoryExtracted(memoryId: string, version: string, factCount: number): Promise<void> {
  await execute(
    `INSERT INTO extraction_log (window_hash, extractor_version, status, fact_count, attempts, processed_at)
     VALUES (?, ?, 'done', ?, 1, ?)
     ON CONFLICT (window_hash, extractor_version) DO UPDATE SET
       status = 'done', fact_count = excluded.fact_count, processed_at = excluded.processed_at`,
    ['mem:' + memoryId, version, factCount, new Date().toISOString()]);
}
