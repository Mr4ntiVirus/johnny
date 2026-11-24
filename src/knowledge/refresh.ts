// Mental-model refresh (full mode in v1).
//
//   staleness gate  ->  gather evidence  ->  synthesize  ->  validate  ->
//   verify against evidence (100% of refreshes)  ->  one repair pass  ->  write
//
// The gate runs BEFORE any model call: a model is stale only when force_stale is
// set or an in-scope active observation/fact is newer than its watermark
// (last_seen_at). Nothing stale => zero tokens spent. The watermark written is
// the newest row actually read, so late writes are picked up next time.

import { embed } from '../utils/llm.js';
import { cosine } from '../engine/embedder.js';
import * as obsDb from '../store/db/observations.js';
import * as factsDb from '../store/db/facts.js';
import * as modelsDb from '../store/db/mental-models.js';
import type { Synthesizer } from './synth.js';
import { extractJsonObject, SynthError } from './synth.js';
import {
  MODEL_SYSTEM, VERIFY_SYSTEM, MODEL_PROMPT_VERSION,
  buildModelPrompt, buildVerifyModelPrompt, type ModelEvidenceInput,
} from './prompts.js';
import { redactSecrets } from './redact.js';
import { BudgetStop } from './governor.js';
import { mapLimit } from './pool.js';
import { splitSections } from './sections.js';
import { embedChunkText } from '../engine/chunker.js';
import { query } from '../store/db-client.js';

const EVIDENCE_CHAR_BUDGET = 14_000;
const MAX_EVIDENCE_ITEMS = 40;
const MIN_CONTENT_CHARS = 60;

export type RefreshOutcome =
  | { status: 'fresh' }                         // gate said nothing changed: zero tokens
  | { status: 'no-evidence' }                   // nothing to write about yet
  | { status: 'written'; chars: number; repaired: boolean; inputTokens: number; outputTokens: number }
  | { status: 'failed'; reason: string; inputTokens: number; outputTokens: number };

export interface EvidenceItem extends ModelEvidenceInput {
  realId: string;
  stamp: string; // updated_at / created_at, used for the watermark
}

/** True when a refresh would actually do something. */
export async function modelIsStale(m: modelsDb.ModelRecord): Promise<boolean> {
  if (m.status !== 'active' || m.paused) return false;
  if (m.force_stale) return true;
  if (!m.content) return true;
  const rows = await query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM observations WHERE scope = ? AND status = 'active' AND review_state != 'rejected' AND updated_at > ?) +
            (SELECT COUNT(*) FROM facts WHERE scope = ? AND status = 'active' AND created_at > ?) AS n`,
    [m.scope, m.last_seen_at ?? '', m.scope, m.last_seen_at ?? '']);
  return (Number(rows[0]?.n) || 0) > 0;
}

/** Cosine a global observation must reach against a project model's query to join its evidence. */
export const GLOBAL_EVIDENCE_MIN = 0.62;

export async function gatherEvidence(m: modelsDb.ModelRecord): Promise<EvidenceItem[]> {
  const q = modelsDb.modelQueryEmbedding(m) ?? await embed(`${m.name}. ${m.source_query}`).catch(() => null);
  const score = (emb: number[] | null, fallback: number) =>
    q && emb && emb.length === q.length ? cosine(q, emb) : fallback;

  const obs = await obsDb.listObservationsInScope(m.scope);
  const globalObs = m.scope === 'global' ? [] : await obsDb.listObservationsInScope('global');

  const items: Array<EvidenceItem & { s: number }> = [];
  for (const o of obs) {
    items.push({ id: '', kind: 'observation', text: o.text, date: o.updated_at, realId: o.id, stamp: o.updated_at,
      s: score(obsDb.observationEmbedding(o), 0.3) + Math.min(0.1, o.proof_count * 0.02) });
  }
  // Only global observations that are clearly ABOUT this model's subject. Generic cross-project user
  // rules score 0.53-0.59 against almost any project query (measured 2026-10-13) and were being
  // restated inside every project model; globals are primed in their own right, so no need.
  const globalPicks = globalObs
    .map(o => ({ o, s: score(obsDb.observationEmbedding(o), 0) }))
    .filter(x => x.s >= GLOBAL_EVIDENCE_MIN).sort((a, b) => b.s - a.s).slice(0, 5);
  for (const { o, s } of globalPicks) {
    items.push({ id: '', kind: 'observation', text: o.text, date: o.updated_at, realId: o.id, stamp: o.updated_at, s });
  }
  // Facts fill in when observations are thin (or not yet consolidated).
  if (items.length < 8) {
    const facts = await factsDb.listActiveFacts(m.scope, 400);
    for (const f of facts) {
      items.push({ id: '', kind: 'fact', text: f.text, date: f.mentioned_at ?? f.created_at, realId: f.id, stamp: f.created_at,
        s: score(factsDb.factEmbedding(f), 0.2) - 0.05 });
    }
  }

  items.sort((a, b) => b.s - a.s);
  const chosen: EvidenceItem[] = [];
  let chars = 0;
  let o = 0, f = 0;
  for (const it of items) {
    if (chosen.length >= MAX_EVIDENCE_ITEMS || chars + it.text.length > EVIDENCE_CHAR_BUDGET) continue;
    chars += it.text.length;
    const id = it.kind === 'observation' ? `O${++o}` : `F${++f}`;
    chosen.push({ id, kind: it.kind, text: it.text, date: it.date, realId: it.realId, stamp: it.stamp });
  }
  return chosen;
}

/** Embed each section of a model document (heading + body); null if the embedder is unavailable. */
export async function embedSections(content: string): Promise<number[][] | null> {
  const vecs: number[][] = [];
  for (const section of splitSections(content)) {
    try { vecs.push(await embedChunkText(section)); } catch { return null; }
  }
  return vecs.length ? vecs : null;
}

const CITE_RE = /\s?\[((?:[OF]\d+)(?:\s*,\s*[OF]\d+)*)\]/g;

export function citedIds(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(CITE_RE)) for (const id of m[1].split(',')) out.add(id.trim());
  return [...out];
}

export function stripCitations(content: string): string {
  return content.replace(CITE_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanDocument(raw: string): string {
  let t = raw.trim();
  const fenced = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) t = fenced[1].trim();
  return t;
}

export function validateModelOutput(
  doc: string, evidence: EvidenceItem[], prev: string | null, maxTokens: number, force: boolean,
): string | null {
  if (doc.length < MIN_CONTENT_CHARS) return 'output-too-short';
  if (doc.length > maxTokens * 4 * 2.2) return 'output-too-long';
  if (!force && prev && prev.length > 200 && doc.length < prev.length * 0.2) return 'output-collapsed-vs-previous';
  const known = new Set(evidence.map(e => e.id));
  for (const id of citedIds(doc)) if (!known.has(id)) return `cites-unknown-id:${id}`;
  if (/^\s*[{[]/.test(doc)) return 'json-output';
  return null;
}

const claimTokens = (t: string): Set<string> =>
  new Set((t.toLowerCase().match(/[a-z0-9][a-z0-9_.$/-]{3,}/g) ?? []));

/**
 * Drop the lines of `doc` that carry claims the verifier rejected: a line goes when at least 60% of a
 * claim's distinctive tokens appear in it. Headings are never dropped. Returns the trimmed document, or
 * null when nothing matched (so the caller does not re-verify an unchanged document).
 */
export function dropUnsupportedLines(doc: string, unsupported: string[]): string | null {
  const claims = unsupported.map(claimTokens).filter(c => c.size >= 2);
  if (claims.length === 0) return null;
  const kept: string[] = [];
  let dropped = 0;
  for (const line of doc.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) { kept.push(line); continue; }
    const lt = claimTokens(line);
    const hit = claims.some(c => { let n = 0; for (const t of c) if (lt.has(t)) n++; return n / c.size >= 0.6; });
    if (hit) dropped++; else kept.push(line);
  }
  return dropped > 0 ? kept.join('\n') : null;
}

async function verifyDocument(
  synth: Synthesizer, doc: string, evidence: EvidenceItem[],
): Promise<{ ok: boolean; unsupported: string[]; inputTokens: number; outputTokens: number }> {
  const res = await synth.complete({
    role: 'verify', system: VERIFY_SYSTEM,
    prompt: buildVerifyModelPrompt(stripCitations(doc), evidence),
  });
  const parsed = extractJsonObject(res.text) as { supported?: unknown; unsupported?: unknown } | null;
  if (!parsed || typeof parsed.supported !== 'boolean') {
    return { ok: false, unsupported: ['verifier returned unparseable output'], inputTokens: res.inputTokens, outputTokens: res.outputTokens };
  }
  const unsupported = Array.isArray(parsed.unsupported) ? parsed.unsupported.filter((x): x is string => typeof x === 'string') : [];
  return { ok: parsed.supported && unsupported.length === 0, unsupported, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}

export async function refreshModel(
  synth: Synthesizer, slug: string, opts: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const m = await modelsDb.getModelBySlug(slug);
  if (!m || m.status !== 'active') return { status: 'fresh' };
  if (!opts.force && !(await modelIsStale(m))) return { status: 'fresh' };

  const evidence = await gatherEvidence(m);
  if (evidence.length === 0) {
    await modelsDb.touchModelSeen(slug, null);
    return { status: 'no-evidence' };
  }
  // Watermark = the newest in-scope row that was AVAILABLE when this refresh ran, not just the
  // rows it chose to cite. Otherwise newer-but-irrelevant observations keep the model "stale"
  // forever and every run burns calls re-refreshing it for nothing.
  const newest = await query<{ m: string | null }>(
    `SELECT MAX(m) AS m FROM (
       SELECT MAX(updated_at) AS m FROM observations WHERE scope = ? AND status = 'active'
       UNION ALL SELECT MAX(created_at) AS m FROM facts WHERE scope = ? AND status = 'active')`, [m.scope, m.scope]);
  const seenAt = [newest[0]?.m ?? '', ...evidence.map(e => e.stamp)].sort().at(-1) || null;

  let inTok = 0, outTok = 0;
  const generate = async (feedback?: string): Promise<string> => {
    const prompt = buildModelPrompt({
      name: m.name, question: m.source_query, scope: m.scope, maxTokens: m.max_tokens,
      evidence, previous: m.content ? stripCitations(m.content) : null,
    }) + (feedback ? `\n\nA fact-checker found these claims UNSUPPORTED by the evidence. Remove or correct them and rewrite the document:\n- ${feedback}` : '');
    const res = await synth.complete({ role: 'model', system: MODEL_SYSTEM, prompt });
    inTok += res.inputTokens; outTok += res.outputTokens;
    return cleanDocument(redactSecrets(res.text));
  };

  try {
    let doc = await generate();
    let bad = validateModelOutput(doc, evidence, m.content, m.max_tokens, !!opts.force);
    if (bad) throw new Error(`model output rejected: ${bad}`);

    let repaired = false;
    let trimmedLines = false;
    let v = await verifyDocument(synth, doc, evidence);
    inTok += v.inputTokens; outTok += v.outputTokens;
    if (!v.ok) {
      repaired = true;
      doc = await generate(v.unsupported.join('\n- '));
      bad = validateModelOutput(doc, evidence, m.content, m.max_tokens, !!opts.force);
      if (bad) throw new Error(`repaired output rejected: ${bad}`);
      v = await verifyDocument(synth, doc, evidence);
      inTok += v.inputTokens; outTok += v.outputTokens;
      if (!v.ok) {
        // Last resort: delete the lines carrying the rejected claims and let the verifier judge the
        // trimmed document. The verifier stays the final authority; nothing unverified is written.
        const trimmed = dropUnsupportedLines(doc, v.unsupported);
        if (!trimmed || trimmed.length < doc.length * 0.6 || validateModelOutput(trimmed, evidence, m.content, m.max_tokens, !!opts.force)) {
          throw new Error(`unsupported claims after repair: ${v.unsupported.slice(0, 3).join(' | ')}`);
        }
        const v3 = await verifyDocument(synth, trimmed, evidence);
        inTok += v3.inputTokens; outTok += v3.outputTokens;
        if (!v3.ok) throw new Error(`unsupported claims after repair+trim: ${v3.unsupported.slice(0, 3).join(' | ')}`);
        doc = trimmed;
        trimmedLines = true;
      }
    }

    const cited = new Set(citedIds(doc));
    const basedOn = evidence.filter(e => cited.has(e.id)).map(e => e.realId);
    const stored = stripCitations(doc);
    await modelsDb.writeModelContent(
      slug, stored, basedOn.length > 0 ? basedOn : evidence.map(e => e.realId), seenAt,
      `refresh ${MODEL_PROMPT_VERSION}${repaired ? ' (repaired)' : ''}${trimmedLines ? ' (trimmed)' : ''}`, await embedSections(stored));
    return { status: 'written', chars: stored.length, repaired, inputTokens: inTok, outputTokens: outTok };
  } catch (err) {
    // A budget/rate-limit/auth stop ends the whole run — let it propagate, don't swallow it per model.
    if (err instanceof BudgetStop) throw err;
    // Other infrastructure errors are transient: report, but don't count toward pausing the model.
    if (!(err instanceof SynthError)) await modelsDb.markModelFailure(slug, String(err));
    return { status: 'failed', reason: String(err), inputTokens: inTok, outputTokens: outTok };
  }
}

/** Refresh every stale active model (a few at a time); returns per-slug outcomes. */
export async function refreshStaleModels(
  synth: Synthesizer, opts: { maxModels?: number; concurrency?: number } = {},
): Promise<Array<{ slug: string; outcome: RefreshOutcome }>> {
  const stale: string[] = [];
  for (const m of await modelsDb.listModels({ status: 'active' })) {
    if (stale.length >= (opts.maxModels ?? 24)) break;
    if (await modelIsStale(m)) stale.push(m.slug);
  }
  const settled = await mapLimit(stale, opts.concurrency ?? 1, async (slug) => ({ slug, outcome: await refreshModel(synth, slug) }));
  const results: Array<{ slug: string; outcome: RefreshOutcome }> = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') results.push(r.value);
    else if (r.reason instanceof BudgetStop) throw r.reason; // ends the whole run (rate limit / budget)
  }
  return results;
}
