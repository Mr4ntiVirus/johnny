// mental_models — standing, auto-created, auto-refreshed prose answers to a
// question about a scope. Reading one is a plain DB lookup (no LLM).

import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../db-client.js';
import { encodeEmbedding, decodeEmbedding } from '../../utils/embedding-codec.js';
import { addHistory } from './knowledge-history.js';
import { splitSections } from '../../knowledge/sections.js';
import { retrievalScopeFilter } from './scope-filter.js';

export type ModelStatus = 'draft' | 'active' | 'archived';

export interface ModelRecord {
  id: string;
  slug: string;
  name: string;
  source_query: string;
  query_embedding: Buffer | null;
  section_embeddings: Buffer | null;
  embedding_model: string | null;
  scope: string;
  max_tokens: number;
  content: string | null;
  status: ModelStatus;
  origin: string;
  refresh_mode: string;
  last_refreshed_at: string | null;
  last_seen_at: string | null;
  based_on: string | null;
  force_stale: number;
  fail_count: number;
  paused: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelInput {
  slug: string;
  name: string;
  sourceQuery: string;
  scope: string;
  maxTokens?: number;
  content?: string | null;
  origin?: 'auto' | 'manual' | 'seed';
  status?: ModelStatus;
  queryEmbedding?: number[] | null;
  embeddingModel?: string | null;
}

const now = () => new Date().toISOString();

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
}

export async function createModel(input: ModelInput): Promise<string> {
  const id = randomUUID();
  const ts = now();
  await execute(
    `INSERT INTO mental_models
       (id, slug, name, source_query, query_embedding, embedding_model, scope, max_tokens,
        content, status, origin, force_stale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, input.slug, input.name, input.sourceQuery,
     input.queryEmbedding ? encodeEmbedding(input.queryEmbedding) : null, input.embeddingModel ?? null,
     input.scope, input.maxTokens ?? 1200, input.content ?? null,
     input.status ?? 'active', input.origin ?? 'auto', ts, ts]);
  return id;
}

export async function getModelBySlug(slug: string): Promise<ModelRecord | null> {
  return queryOne<ModelRecord>('SELECT * FROM mental_models WHERE slug = ?', [slug]);
}

export async function getModel(id: string): Promise<ModelRecord | null> {
  return queryOne<ModelRecord>('SELECT * FROM mental_models WHERE id = ?', [id]);
}

export async function listModels(opts: { status?: ModelStatus; scope?: string; includeWorkspaceChildren?: boolean } = {}): Promise<ModelRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.scope) { const f = opts.includeWorkspaceChildren ? retrievalScopeFilter(opts.scope) : { clause: '(scope = ? OR scope = ?)', params: [opts.scope, 'global'] }; where.push(f.clause); params.push(...f.params); }
  return query<ModelRecord>(
    `SELECT * FROM mental_models ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`, params);
}

/** Write refreshed content: previous version goes to history; watermark = newest row actually read. */
export async function writeModelContent(
  slug: string, content: string, basedOn: string[], seenAt: string | null, reason: string,
  sectionVecs?: number[][] | null,
): Promise<void> {
  const prev = await getModelBySlug(slug);
  if (!prev) return;
  if (prev.content) await addHistory('model', prev.id, prev.content, reason);
  const ts = now();
  await execute(
    `UPDATE mental_models SET content = ?, based_on = ?, last_refreshed_at = ?, last_seen_at = ?,
       section_embeddings = ?, force_stale = 0, fail_count = 0, last_error = NULL, paused = 0, updated_at = ? WHERE slug = ?`,
    [content, JSON.stringify(basedOn), ts, seenAt ?? prev.last_seen_at,
     sectionVecs ? encodeSectionVectors(sectionVecs) : null, ts, slug]);
}

/** Advance the watermark without touching content (nothing topic-relevant changed). */
export async function touchModelSeen(slug: string, seenAt: string | null): Promise<void> {
  await execute(
    `UPDATE mental_models SET last_refreshed_at = ?, last_seen_at = COALESCE(?, last_seen_at),
       force_stale = 0, updated_at = ? WHERE slug = ?`, [now(), seenAt, now(), slug]);
}

export async function markModelFailure(slug: string, error: string, pauseAfter = 3): Promise<void> {
  await execute(
    `UPDATE mental_models SET fail_count = fail_count + 1, last_error = ?, updated_at = ? WHERE slug = ?`,
    [error.slice(0, 500), now(), slug]);
  await execute(
    `UPDATE mental_models SET paused = 1 WHERE slug = ? AND fail_count >= ?`, [slug, pauseAfter]);
}

/**
 * A model that failed verification 3 times is paused so a bad run can't loop forever, but a pause only a
 * human could lift contradicts the fully automatic design (four core models sat frozen for a day). After a
 * cooldown, un-pause it for exactly ONE more attempt: fail_count stays at pauseAfter-1, so the next
 * failure re-pauses it at once. Returns the slugs resumed.
 */
export async function resumeCooledModels(cooldownMs = 6 * 60 * 60_000, pauseAfter = 3): Promise<string[]> {
  const cutoff = new Date(Date.now() - cooldownMs).toISOString();
  const rows = await query<{ slug: string }>(
    `SELECT slug FROM mental_models WHERE paused = 1 AND status = 'active' AND updated_at < ?`, [cutoff]);
  for (const r of rows) {
    await execute(`UPDATE mental_models SET paused = 0, fail_count = ?, force_stale = 1, updated_at = ? WHERE slug = ?`,
      [Math.max(0, pauseAfter - 1), now(), r.slug]);
  }
  return rows.map(r => r.slug);
}

export async function setModelStatus(slug: string, status: ModelStatus): Promise<void> {
  await execute('UPDATE mental_models SET status = ?, updated_at = ? WHERE slug = ?', [status, now(), slug]);
}

export async function forceStale(slugs: string[]): Promise<void> {
  for (const s of slugs) {
    await execute('UPDATE mental_models SET force_stale = 1, updated_at = ? WHERE slug = ?', [now(), s]);
  }
}

export async function setModelQueryEmbedding(slug: string, e: number[], model: string): Promise<void> {
  await execute('UPDATE mental_models SET query_embedding = ?, embedding_model = ? WHERE slug = ?',
    [encodeEmbedding(e), model, slug]);
}

/** One float32 vector per section (in splitSections order), concatenated. */
export function encodeSectionVectors(vecs: number[][]): Buffer {
  return Buffer.concat(vecs.map(v => encodeEmbedding(v)));
}

/** Decode section vectors; null unless the count matches the document's current sections. */
export function modelSectionEmbeddings(m: { content: string | null; section_embeddings: Buffer | null }): number[][] | null {
  if (!m.content || !m.section_embeddings || m.section_embeddings.length === 0) return null;
  const n = splitSections(m.content).length;
  if (n === 0 || m.section_embeddings.length % n !== 0) return null;
  const per = m.section_embeddings.length / n;
  const out: number[][] = [];
  try {
    for (let i = 0; i < n; i++) out.push(decodeEmbedding(m.section_embeddings.subarray(i * per, (i + 1) * per)));
  } catch { return null; }
  return out;
}

export async function setModelSectionEmbeddings(slug: string, vecs: number[][]): Promise<void> {
  await execute('UPDATE mental_models SET section_embeddings = ? WHERE slug = ?', [encodeSectionVectors(vecs), slug]);
}

export async function modelsNeedingSectionEmbeddings(): Promise<ModelRecord[]> {
  return query<ModelRecord>(
    `SELECT * FROM mental_models WHERE status = 'active' AND content IS NOT NULL AND section_embeddings IS NULL`);
}

export function modelQueryEmbedding(m: { query_embedding: Buffer | null }): number[] | null {
  if (!m.query_embedding) return null;
  try { return decodeEmbedding(m.query_embedding); } catch { return null; }
}

export function modelBasedOn(m: { based_on: string | null }): string[] {
  if (!m.based_on) return [];
  try { const v = JSON.parse(m.based_on); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export async function countModels(): Promise<number> {
  const r = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM mental_models WHERE status = 'active'`);
  return Number(r?.n) || 0;
}
