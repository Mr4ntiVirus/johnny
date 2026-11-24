// telemetry — hint_telemetry and recall_telemetry. Append-only.

import { query, queryOne, execute } from '../db-client.js';

export const PROMPT_EXCERPT_CHARS = 400;

export type HintForm = 'form1' | 'form2' | 'form3' | 'recommend_memory' | 'suggest_memories' | 'bootstrap' | 'offer' | 'knowledge';

export interface HintTelemetryInput {
  sessionId: string;
  form: HintForm;
  suggestedMemoryIds: string[];
  topScore?: number;
  threshold?: number;
  tokenEstimate?: number;
  /** First chars of the triggering prompt, kept locally so `johnny eval-recommend` can label hints later. */
  promptExcerpt?: string;
}

export interface RecallTelemetryInput {
  sessionId: string;
  query?: string;
  requestedNames?: string[];
  excludedChunkIds?: string[];
  chunksReturned: number;
  memoryIds: string[];
}

export interface HintTelemetryRecord {
  id: number;
  session_id: string | null;
  emitted_at: string;
  form: HintForm;
  suggested_memory_ids: string | null;
  top_score: number | null;
  threshold: number | null;
  token_estimate: number | null;
  prompt_excerpt?: string | null;
}

export interface RecallTelemetryRecord {
  id: number;
  session_id: string | null;
  called_at: string;
  query: string | null;
  requested_names: string | null;
  excluded_chunk_ids: string | null;
  chunks_returned: number;
  memory_ids: string | null;
}

// Both functions return Promise<void> so callers that need ordering can await
// them. Hot-path callers (hooks, MCP handler) may leave them fire-and-forget by
// not awaiting — errors are silently swallowed in either case.
export async function logHintEmission(input: HintTelemetryInput): Promise<void> {
  const base = [
    input.sessionId, new Date().toISOString(), input.form,
    JSON.stringify(input.suggestedMemoryIds),
    input.topScore ?? null, input.threshold ?? null, input.tokenEstimate ?? null,
  ];
  try {
    await execute(
      `INSERT INTO hint_telemetry
         (session_id, emitted_at, form, suggested_memory_ids, top_score, threshold, token_estimate, prompt_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [...base, input.promptExcerpt ? input.promptExcerpt.slice(0, PROMPT_EXCERPT_CHARS) : null],
    );
  } catch {
    // Store without the prompt_excerpt column (e.g. Postgres before migration 005): keep the core row.
    await execute(
      `INSERT INTO hint_telemetry
         (session_id, emitted_at, form, suggested_memory_ids, top_score, threshold, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      base,
    );
  }
}

export async function logRecallCall(input: RecallTelemetryInput): Promise<void> {
  await execute(
    `INSERT INTO recall_telemetry
       (session_id, called_at, query, requested_names, excluded_chunk_ids, chunks_returned, memory_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionId, new Date().toISOString(), input.query ?? null,
      input.requestedNames ? JSON.stringify(input.requestedNames) : null,
      input.excludedChunkIds ? JSON.stringify(input.excludedChunkIds) : null,
      input.chunksReturned, JSON.stringify(input.memoryIds),
    ],
  );
}

export async function getHintTelemetry(limit = 100): Promise<HintTelemetryRecord[]> {
  return query<HintTelemetryRecord>('SELECT * FROM hint_telemetry ORDER BY emitted_at DESC LIMIT ?', [limit]);
}

export async function getRecallTelemetry(limit = 100): Promise<RecallTelemetryRecord[]> {
  return query<RecallTelemetryRecord>('SELECT * FROM recall_telemetry ORDER BY called_at DESC LIMIT ?', [limit]);
}

export interface ConversionRollup {
  hintsEmitted: number;
  recallsTriggered: number;
  conversionRate: number;
}

// A hint "converts" when the SAME session later calls johnny_recall on a memory that hint suggested.
// (Previously this divided two global counts, so unrelated recalls inflated it and recall_telemetry gaps
// zeroed it.) Hints that suggested no memory (knowledge/bootstrap forms) are not part of the denominator.
export async function computeConversionRollup(sinceIso?: string): Promise<ConversionRollup> {
  const since = sinceIso ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [hints, recalls] = await Promise.all([
    query<{ session_id: string | null; emitted_at: string; suggested_memory_ids: string | null }>(
      'SELECT session_id, emitted_at, suggested_memory_ids FROM hint_telemetry WHERE emitted_at >= ?', [since]),
    query<{ session_id: string | null; called_at: string; memory_ids: string | null }>(
      'SELECT session_id, called_at, memory_ids FROM recall_telemetry WHERE called_at >= ?', [since]),
  ]);
  const parse = (j: string | null): string[] => { try { return j ? (JSON.parse(j) as string[]) : []; } catch { return []; } };
  const recallsBySession = new Map<string, Array<{ at: string; ids: Set<string> }>>();
  for (const r of recalls) {
    if (!r.session_id) continue;
    const list = recallsBySession.get(r.session_id) ?? [];
    list.push({ at: r.called_at, ids: new Set(parse(r.memory_ids)) });
    recallsBySession.set(r.session_id, list);
  }
  let hintsEmitted = 0, recallsTriggered = 0;
  for (const h of hints) {
    const ids = parse(h.suggested_memory_ids);
    if (ids.length === 0) continue;
    hintsEmitted++;
    const later = h.session_id ? (recallsBySession.get(h.session_id) ?? []) : [];
    if (later.some(r => r.at >= h.emitted_at && ids.some(id => r.ids.has(id)))) recallsTriggered++;
  }
  return { hintsEmitted, recallsTriggered, conversionRate: hintsEmitted === 0 ? 0 : recallsTriggered / hintsEmitted };
}
