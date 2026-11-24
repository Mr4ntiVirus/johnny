// Fact extraction: windows -> Claude (tool-less) -> validated facts.
// Validators are the anti-hallucination layer: each fact must carry an exact
// quote that is a (whitespace/case-normalised) substring of its window.

import { embed, getEmbedModelName } from '../utils/llm.js';
import { normalizeForHash } from '../utils/content-hash.js';
import { createFact, getExtractionLog, recordExtraction, normalizeEntity, FACT_KINDS, type FactKind } from '../store/db/facts.js';
import { query } from '../store/db-client.js';
import type { Synthesizer } from './synth.js';
import { extractJsonObject } from './synth.js';
import { EXTRACT_SYSTEM, EXTRACTOR_VERSION, buildExtractPrompt } from './prompts.js';
import { redactSecrets } from './redact.js';
import { dumpDebug } from './debug.js';
import type { ExtractWindow } from './windows.js';

export interface WindowContext extends ExtractWindow {
  scope: string;        // project scope of the source memory
  sessionId: string | null;
  mentionedAt: string;  // source memory created_at
  title: string;
}

export interface ParsedFact {
  text: string;
  kind: FactKind;
  when: string;
  applies: 'global' | 'project';
  entities: string[];
  quote: string;
}

export interface ExtractStats {
  windowsSent: number;
  windowsSkippedDone: number;
  windowsGaveUp: number;
  windowsFailed: number;
  factsAccepted: number;
  factsRejected: number;
  rejectReasons: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** Facts created this call, with their source window — for verifier sampling. */
  created: Array<{ id: string; text: string; quote: string; windowText: string; windowHash: string; memoryId: string }>;
}

export const MAX_WINDOW_ATTEMPTS = 3;
const MAX_FACT_CHARS = 500;
const MIN_QUOTE = 12;
const MAX_QUOTE = 400;

export function normalizeForQuote(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

export function quoteInWindow(quote: string, windowText: string): boolean {
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE) return false;
  return normalizeForQuote(windowText).includes(q);
}

/** Parse + validate one window's facts from the model's JSON. Pure; exported for tests. */
export function validateFacts(
  raw: unknown, windowText: string,
): { facts: ParsedFact[]; rejected: Array<{ reason: string }> } {
  const facts: ParsedFact[] = [];
  const rejected: Array<{ reason: string }> = [];
  const arr = Array.isArray(raw) ? raw : [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') { rejected.push({ reason: 'not-object' }); continue; }
    const o = f as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    const quote = typeof o.quote === 'string' ? o.quote.trim() : '';
    const kind = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
    if (!text) { rejected.push({ reason: 'empty-text' }); continue; }
    if (text.length > MAX_FACT_CHARS) { rejected.push({ reason: 'too-long' }); continue; }
    if (!FACT_KINDS.includes(kind as FactKind)) { rejected.push({ reason: 'bad-kind' }); continue; }
    if (quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) { rejected.push({ reason: 'bad-quote-length' }); continue; }
    if (!quoteInWindow(quote, windowText)) { rejected.push({ reason: 'quote-not-in-window' }); continue; }
    const entities = Array.isArray(o.entities)
      ? o.entities.filter((e): e is string => typeof e === 'string').map(e => e.trim()).filter(Boolean).slice(0, 12)
      : [];
    facts.push({
      text,
      kind: kind as FactKind,
      when: typeof o.when === 'string' ? o.when.trim() : '',
      applies: o.applies === 'global' ? 'global' : 'project',
      entities,
      quote,
    });
  }
  return { facts, rejected };
}

async function findExactDuplicate(scope: string, text: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM facts WHERE scope = ? AND text = ? AND status = 'active' LIMIT 1`, [scope, text]);
  return rows.length > 0;
}

function isoDateOrNull(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Extract facts from a batch of windows in ONE model call. Idempotent per
 * (window hash, extractor version): windows already logged are skipped.
 */
export async function extractWindows(
  synth: Synthesizer,
  windows: WindowContext[],
  opts: { version?: string; embedFacts?: boolean } = {},
): Promise<ExtractStats> {
  const version = opts.version ?? EXTRACTOR_VERSION;
  const stats: ExtractStats = {
    windowsSent: 0, windowsSkippedDone: 0, windowsGaveUp: 0, windowsFailed: 0, factsAccepted: 0, factsRejected: 0,
    rejectReasons: {}, inputTokens: 0, outputTokens: 0, created: [],
  };

  const todo: WindowContext[] = [];
  const seenHashes = new Set<string>();
  for (const w of windows) {
    if (seenHashes.has(w.hash)) { stats.windowsSkippedDone++; continue; } // same content twice in one batch
    seenHashes.add(w.hash);
    const log = await getExtractionLog(w.hash, version);
    if (log && (log.status === 'done' || log.status === 'skipped')) { stats.windowsSkippedDone++; continue; }
    if (log && log.status === 'failed' && log.attempts >= MAX_WINDOW_ATTEMPTS) {
      // Persistently unusable window: give up so it can't stall the whole backfill.
      await recordExtraction(w.hash, version, 'skipped', 0, `gave up after ${log.attempts} attempts: ${log.last_error ?? ''}`);
      stats.windowsGaveUp++;
      continue;
    }
    todo.push(w);
  }
  if (todo.length === 0) return stats;

  // Batches share one project scope so the prompt can state it.
  const byScope = new Map<string, WindowContext[]>();
  for (const w of todo) {
    const list = byScope.get(w.scope) ?? [];
    list.push(w);
    byScope.set(w.scope, list);
  }

  // One model call for a group of windows. If the reply is unusable, split the
  // group and retry each window alone, so a single poison window can't take the
  // others down with it; a window that still fails is logged (attempt counted)
  // and abandoned after MAX_WINDOW_ATTEMPTS.
  const processGroup = async (scope: string, group: WindowContext[], allowSplit: boolean, allowRetry = true): Promise<void> => {
    const ids = new Map<string, WindowContext>();
    const inputs = group.map((w, i) => {
      const id = `W${i + 1}`;
      ids.set(id, w);
      return { id, date: w.mentionedAt, title: w.title, text: redactSecrets(w.text) };
    });
    stats.windowsSent += inputs.length;

    const res = await synth.complete({
      role: 'extract', system: EXTRACT_SYSTEM, prompt: buildExtractPrompt(scope, inputs),
    });
    stats.inputTokens += res.inputTokens;
    stats.outputTokens += res.outputTokens;

    const parsed = extractJsonObject(res.text) as { windows?: Array<{ id?: string; facts?: unknown }> } | null;
    if (!parsed || !Array.isArray(parsed.windows)) {
      if (allowSplit && group.length > 1) {
        stats.windowsSent -= inputs.length; // re-counted when retried individually
        for (const w of group) await processGroup(scope, [w], false, true);
        return;
      }
      if (group.length === 1 && allowRetry) {
        // Sloppy JSON is usually a one-off: one immediate fresh attempt before counting a failure.
        stats.windowsSent -= inputs.length;
        return processGroup(scope, group, false, false);
      }
      for (const w of group) await recordExtraction(w.hash, version, 'failed', 0, 'unparseable model output');
      stats.windowsFailed += group.length;
      dumpDebug('extract-unparseable', { windows: group.map(w => w.hash.slice(0, 10)).join(','), reply: res.text, promptHead: buildExtractPrompt(scope, inputs).slice(0, 1500) });
      return;
    }

    const answered = new Set<string>();
    for (const wr of parsed.windows) {
      const id = typeof wr.id === 'string' ? wr.id : '';
      const w = ids.get(id);
      if (!w) continue;
      answered.add(id);
      const { facts, rejected } = validateFacts(wr.facts, redactSecrets(w.text));
      for (const r of rejected) {
        stats.factsRejected++;
        stats.rejectReasons[r.reason] = (stats.rejectReasons[r.reason] ?? 0) + 1;
      }
      let accepted = 0;
      for (const f of facts) {
        const text = redactSecrets(f.text);
        const factScope = f.applies === 'global' ? 'global' : w.scope;
        if (await findExactDuplicate(factScope, text)) continue;
        let embedding: number[] | null = null;
        if (opts.embedFacts !== false) {
          try { embedding = await embed(text); } catch { embedding = null; }
        }
        const when = isoDateOrNull(f.when);
        const factId = await createFact({
          scope: factScope,
          text,
          context: null,
          kind: f.kind,
          occurredStart: f.kind === 'event' ? when : null,
          occurredEnd: f.kind === 'event' ? when : null,
          mentionedAt: w.mentionedAt,
          sourceMemoryId: w.memoryId,
          sourceChunkId: w.chunkIds[0] ?? null,
          sourceQuote: redactSecrets(f.quote),
          sessionId: w.sessionId,
          windowHash: w.hash,
          extractorVersion: version,
          embedding, embeddingModel: embedding ? getEmbedModelName() : null,
          entities: f.entities.map(normalizeEntity),
        });
        stats.created.push({ id: factId, text, quote: redactSecrets(f.quote), windowText: redactSecrets(w.text), windowHash: w.hash, memoryId: w.memoryId });
        accepted++;
      }
      stats.factsAccepted += accepted;
      await recordExtraction(w.hash, version, accepted === 0 && facts.length === 0 ? 'skipped' : 'done', accepted);
    }
    // Windows the model silently dropped count as a failed attempt (so they are
    // retried a bounded number of times, then abandoned) instead of looping forever.
    for (const [id, w] of ids) {
      if (!answered.has(id)) { await recordExtraction(w.hash, version, 'failed', 0, 'window omitted from model reply'); stats.windowsFailed++; }
    }
  };

  for (const [scope, group] of byScope) await processGroup(scope, group, true);
  return stats;
}

export { normalizeForHash };
