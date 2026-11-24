// observations — consolidated, evidence-linked beliefs. Refined, never
// overwritten without a history row; contradicted → superseded (never deleted).
// proof_count = number of DISTINCT SESSIONS backing the observation, so one
// long session can't count as several corroborations.

import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../db-client.js';
import { encodeEmbedding, decodeEmbedding } from '../../utils/embedding-codec.js';
import { addHistory } from './knowledge-history.js';
import { retrievalScopeFilter } from './scope-filter.js';

export type ObservationStatus = 'active' | 'superseded' | 'retired';
export type ReviewState = 'auto' | 'approved' | 'rejected';

export interface ObservationRecord {
  id: string;
  scope: string;
  facet: string | null;
  subject: string | null;
  text: string;
  status: ObservationStatus;
  superseded_by: string | null;
  valid_from: string | null;
  valid_to: string | null;
  proof_count: number;
  review_state: ReviewState;
  embedding: Buffer | null;
  embedding_model: string | null;
  consolidator_version: string | null;
  invalidation_count: number;
  created_at: string;
  updated_at: string;
  last_evidence_at: string | null;
}

export interface EvidenceRecord {
  observation_id: string;
  fact_id: string;
  quote: string | null;
  role: 'supports' | 'contradicts';
  added_at: string;
}

export interface ObservationInput {
  scope: string;
  text: string;
  facet?: string | null;
  subject?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  consolidatorVersion?: string | null;
  validFrom?: string | null;
}

const now = () => new Date().toISOString();

export async function createObservation(input: ObservationInput, reason = 'created'): Promise<string> {
  const id = randomUUID();
  const ts = now();
  await execute(
    `INSERT INTO observations
       (id, scope, facet, subject, text, status, valid_from, proof_count, review_state,
        embedding, embedding_model, consolidator_version, created_at, updated_at, last_evidence_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 0, 'auto', ?, ?, ?, ?, ?, ?)`,
    [id, input.scope, input.facet ?? null, input.subject ?? null, input.text,
     input.validFrom ?? ts,
     input.embedding ? encodeEmbedding(input.embedding) : null, input.embeddingModel ?? null,
     input.consolidatorVersion ?? null, ts, ts, ts],
  );
  await addHistory('observation', id, input.text, reason);
  return id;
}

export async function getObservation(id: string): Promise<ObservationRecord | null> {
  return queryOne<ObservationRecord>('SELECT * FROM observations WHERE id = ?', [id]);
}

export async function getObservations(ids: string[]): Promise<ObservationRecord[]> {
  const out: ObservationRecord[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    out.push(...await query<ObservationRecord>(
      `SELECT * FROM observations WHERE id IN (${slice.map(() => '?').join(',')})`, slice));
  }
  return out;
}

/** Observations eligible to surface/prime: active and not rejected. */
export async function listActiveObservations(scope?: string | null, limit = 500, includeWorkspaceChildren = false): Promise<ObservationRecord[]> {
  const params: unknown[] = [];
  let where = `status = 'active' AND review_state != 'rejected'`;
  if (scope) { const f = includeWorkspaceChildren ? retrievalScopeFilter(scope) : { clause: '(scope = ? OR scope = ?)', params: [scope, 'global'] }; where += ' AND ' + f.clause; params.push(...f.params); }
  params.push(limit);
  return query<ObservationRecord>(
    `SELECT * FROM observations WHERE ${where} ORDER BY updated_at DESC LIMIT ?`, params);
}

/** Active, non-rejected observations of exactly one scope (no cross-scope truncation). */
export async function listObservationsInScope(scope: string, limit = 5000): Promise<ObservationRecord[]> {
  return query<ObservationRecord>(
    `SELECT * FROM observations WHERE scope = ? AND status = 'active' AND review_state != 'rejected'
     ORDER BY updated_at DESC LIMIT ?`, [scope, limit]);
}

export async function updateObservationText(
  id: string, text: string, reason: string,
  embedding?: number[] | null, embeddingModel?: string | null,
): Promise<void> {
  const prev = await getObservation(id);
  if (!prev) return;
  await addHistory('observation', id, prev.text, reason);
  await execute(
    `UPDATE observations SET text = ?, embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?`,
    [text, embedding ? encodeEmbedding(embedding) : null, embeddingModel ?? prev.embedding_model, now(), id]);
}

export async function supersedeObservation(id: string, successorId: string | null, reason: string): Promise<void> {
  const prev = await getObservation(id);
  if (!prev) return;
  await addHistory('observation', id, prev.text, `superseded: ${reason}`);
  const ts = now();
  await execute(
    `UPDATE observations SET status = ?, superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?`,
    [successorId ? 'superseded' : 'retired', successorId, ts, ts, id]);
}

export async function addEvidence(
  observationId: string, factId: string, quote: string | null, role: 'supports' | 'contradicts' = 'supports',
): Promise<void> {
  await execute(
    `INSERT INTO observation_evidence (observation_id, fact_id, quote, role, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (observation_id, fact_id) DO UPDATE SET
       role = excluded.role,
       quote = COALESCE(excluded.quote, observation_evidence.quote)`,
    [observationId, factId, quote, role, now()]);
  await execute('UPDATE observations SET last_evidence_at = ?, updated_at = ? WHERE id = ?', [now(), now(), observationId]);
}

export async function getEvidence(observationId: string): Promise<EvidenceRecord[]> {
  return query<EvidenceRecord>(
    'SELECT * FROM observation_evidence WHERE observation_id = ? ORDER BY added_at ASC', [observationId]);
}

export async function observationsForFact(factId: string): Promise<string[]> {
  const rows = await query<{ observation_id: string }>(
    'SELECT observation_id FROM observation_evidence WHERE fact_id = ?', [factId]);
  return rows.map(r => r.observation_id);
}

/** proof_count = distinct sessions among the SUPPORTING facts (never taken from the LLM). */
export async function recomputeProof(observationId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT COALESCE(f.session_id, f.source_memory_id, f.id)) AS n
     FROM observation_evidence e JOIN facts f ON f.id = e.fact_id
     WHERE e.observation_id = ? AND e.role = 'supports'`, [observationId]);
  const n = Number(row?.n) || 0;
  await execute('UPDATE observations SET proof_count = ? WHERE id = ?', [n, observationId]);
  return n;
}

export async function setReviewState(id: string, state: ReviewState): Promise<void> {
  await execute('UPDATE observations SET review_state = ?, updated_at = ? WHERE id = ?', [state, now(), id]);
}

export async function invalidateObservation(id: string): Promise<void> {
  await execute(
    `UPDATE observations SET invalidation_count = invalidation_count + 1, updated_at = ? WHERE id = ?`, [now(), id]);
}

export function observationEmbedding(o: { embedding: Buffer | null }): number[] | null {
  if (!o.embedding) return null;
  try { return decodeEmbedding(o.embedding); } catch { return null; }
}

export async function observationsNewerThan(sinceIso: string | null, scope?: string): Promise<number> {
  const params: unknown[] = [];
  let where = `status = 'active'`;
  if (sinceIso) { where += ' AND updated_at > ?'; params.push(sinceIso); }
  if (scope) { where += ' AND scope = ?'; params.push(scope); }
  const r = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM observations WHERE ${where}`, params);
  return Number(r?.n) || 0;
}

export async function countObservations(): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM observations WHERE status = 'active'`);
  return Number(r?.n) || 0;
}
