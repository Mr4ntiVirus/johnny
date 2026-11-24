// facts — structured, quote-grounded statements extracted from transcript
// windows. Supersede-never-delete: a replaced fact keeps its row with
// status='superseded', superseded_by and valid_to set.

import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../db-client.js';
import { encodeEmbedding, decodeEmbedding } from '../../utils/embedding-codec.js';
import { retrievalScopeFilter } from './scope-filter.js';

export type FactKind = 'decision' | 'state' | 'convention' | 'event' | 'lesson';
export type FactStatus = 'active' | 'superseded' | 'disputed';
export const FACT_KINDS: FactKind[] = ['decision', 'state', 'convention', 'event', 'lesson'];

export interface FactInput {
  id?: string;
  scope: string;
  text: string;
  context?: string | null;
  kind: FactKind;
  occurredStart?: string | null;
  occurredEnd?: string | null;
  mentionedAt?: string | null;
  sourceMemoryId?: string | null;
  sourceChunkId?: string | null;
  sourceQuote?: string | null;
  sessionId?: string | null;
  windowHash?: string | null;
  extractorVersion?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  origin?: 'extracted' | 'remember';
  entities?: string[];
}

export interface FactRecord {
  id: string;
  scope: string;
  text: string;
  context: string | null;
  kind: FactKind;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string | null;
  source_memory_id: string | null;
  source_chunk_id: string | null;
  source_quote: string | null;
  session_id: string | null;
  window_hash: string | null;
  extractor_version: string | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  status: FactStatus;
  superseded_by: string | null;
  valid_to: string | null;
  invalidation_count: number;
  origin: string;
  created_at: string;
}

export function normalizeEntity(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\s._/-]/gu, '').replace(/\s+/g, ' ').trim();
}

export async function createFact(input: FactInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await execute(
    `INSERT INTO facts
       (id, scope, text, context, kind, occurred_start, occurred_end, mentioned_at,
        source_memory_id, source_chunk_id, source_quote, session_id, window_hash,
        extractor_version, embedding, embedding_model, status, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, input.scope, input.text, input.context ?? null, input.kind,
     input.occurredStart ?? null, input.occurredEnd ?? null, input.mentionedAt ?? null,
     input.sourceMemoryId ?? null, input.sourceChunkId ?? null, input.sourceQuote ?? null,
     input.sessionId ?? null, input.windowHash ?? null, input.extractorVersion ?? null,
     input.embedding ? encodeEmbedding(input.embedding) : null, input.embeddingModel ?? null,
     input.origin ?? 'extracted', new Date().toISOString()],
  );
  for (const e of new Set((input.entities ?? []).map(normalizeEntity).filter(Boolean))) {
    await execute(
      'INSERT INTO fact_entities (fact_id, entity_norm) VALUES (?, ?) ON CONFLICT (fact_id, entity_norm) DO NOTHING',
      [id, e],
    );
  }
  return id;
}

export async function getFact(id: string): Promise<FactRecord | null> {
  return queryOne<FactRecord>('SELECT * FROM facts WHERE id = ?', [id]);
}

export async function getFacts(ids: string[]): Promise<FactRecord[]> {
  if (ids.length === 0) return [];
  const out: FactRecord[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    out.push(...await query<FactRecord>(
      `SELECT * FROM facts WHERE id IN (${slice.map(() => '?').join(',')})`, slice));
  }
  return out;
}

/** `forRetrieval`: also match global + (for a non-git workspace scope) descendant project scopes. */
export async function listActiveFacts(scope: string | null, limit = 200, sinceIso?: string, forRetrieval = false): Promise<FactRecord[]> {
  const where: string[] = [`status = 'active'`];
  const params: unknown[] = [];
  if (scope && forRetrieval) { const f = retrievalScopeFilter(scope); where.push(f.clause); params.push(...f.params); }
  else if (scope) { where.push('scope = ?'); params.push(scope); }
  if (sinceIso) { where.push('created_at > ?'); params.push(sinceIso); }
  params.push(limit);
  // Retrieval wants the NEWEST facts under the cap (an ASC cap silently drops everything recent);
  // introspection/maintenance callers keep the stable oldest-first order.
  return query<FactRecord>(
    `SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY created_at ${forRetrieval ? 'DESC' : 'ASC'} LIMIT ?`, params);
}

export async function getFactEntities(factId: string): Promise<string[]> {
  const rows = await query<{ entity_norm: string }>('SELECT entity_norm FROM fact_entities WHERE fact_id = ?', [factId]);
  return rows.map(r => r.entity_norm);
}

export async function findFactsByEntity(entityNorm: string, limit = 50): Promise<FactRecord[]> {
  return query<FactRecord>(
    `SELECT f.* FROM facts f JOIN fact_entities e ON e.fact_id = f.id
     WHERE e.entity_norm = ? AND f.status = 'active' ORDER BY f.created_at DESC LIMIT ?`,
    [entityNorm, limit]);
}

export async function supersedeFact(id: string, successorId: string | null): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    `UPDATE facts SET status = 'superseded', superseded_by = ?, valid_to = ? WHERE id = ?`,
    [successorId, now, id]);
}

/** Mark disputed after an explicit invalidation; two invalidations or a replacement supersede. */
export async function invalidateFact(id: string, replacementId?: string | null): Promise<FactStatus | null> {
  const f = await getFact(id);
  if (!f) return null;
  if (replacementId) { await supersedeFact(id, replacementId); return 'superseded'; }
  const count = f.invalidation_count + 1;
  await execute(
    `UPDATE facts SET invalidation_count = ?, status = CASE WHEN ? >= 2 THEN 'disputed' ELSE status END WHERE id = ?`,
    [count, count, id]);
  return count >= 2 ? 'disputed' : f.status;
}

/** Verifier found the fact unsupported by its source: excluded from consolidation/recall. */
export async function disputeFact(id: string): Promise<void> {
  await execute(`UPDATE facts SET status = 'disputed', invalidation_count = 2 WHERE id = ?`, [id]);
}

export async function setFactEmbedding(id: string, embedding: number[], model: string): Promise<void> {
  await execute('UPDATE facts SET embedding = ?, embedding_model = ? WHERE id = ?', [encodeEmbedding(embedding), model, id]);
}

export function factEmbedding(f: { embedding: Buffer | null }): number[] | null {
  if (!f.embedding) return null;
  try { return decodeEmbedding(f.embedding); } catch { return null; }
}

export async function countFacts(): Promise<number> {
  const r = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM facts');
  return Number(r?.n) || 0;
}

export async function getFactsNeedingEmbedding(limit: number): Promise<{ id: string; text: string }[]> {
  return query<{ id: string; text: string }>('SELECT id, text FROM facts WHERE embedding IS NULL LIMIT ?', [limit]);
}

// ── extraction_log (idempotency) ─────────────────────────────────────────────

export interface ExtractionLogRecord {
  window_hash: string;
  extractor_version: string;
  status: 'done' | 'failed' | 'skipped';
  fact_count: number;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
}

export async function getExtractionLog(windowHash: string, version: string): Promise<ExtractionLogRecord | null> {
  return queryOne<ExtractionLogRecord>(
    'SELECT * FROM extraction_log WHERE window_hash = ? AND extractor_version = ?', [windowHash, version]);
}

export async function recordExtraction(
  windowHash: string, version: string, status: ExtractionLogRecord['status'],
  factCount: number, error?: string,
): Promise<void> {
  await execute(
    `INSERT INTO extraction_log (window_hash, extractor_version, status, fact_count, attempts, last_error, processed_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (window_hash, extractor_version) DO UPDATE SET
       status = excluded.status, fact_count = excluded.fact_count,
       attempts = extraction_log.attempts + 1, last_error = excluded.last_error,
       processed_at = excluded.processed_at`,
    [windowHash, version, status, factCount, error ? error.slice(0, 500) : null, new Date().toISOString()]);
}

export async function countExtracted(version: string): Promise<number> {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM extraction_log WHERE extractor_version = ? AND status IN ('done','skipped')`, [version]);
  return Number(r?.n) || 0;
}
