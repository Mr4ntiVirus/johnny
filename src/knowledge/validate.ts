// Pure validators for model-produced consolidation ops. This is the layer that
// stands between an LLM's output and the durable knowledge store, so it is
// deliberately strict: anything that can't be verified is dropped, never
// guessed. (Hindsight trusts the model here; we do not.)

export type OpKind = 'create' | 'update' | 'supersede' | 'retire';

export interface RawOp {
  op?: unknown; text?: unknown; facet?: unknown; subject?: unknown;
  facts?: unknown; obs?: unknown; considered?: unknown; reason?: unknown;
}

export interface ValidOp {
  op: OpKind;
  text: string;
  facet: string | null;
  subject: string | null;
  factRefs: string[];        // short ids (F1..) — resolved to real ids by the caller
  obsRef: string | null;     // short id (O1..) for update/supersede/retire
  reason: string;
}

export interface Rejection { index: number; reason: string }

export interface ValidationContext {
  /** short id -> text/quote/date digits of the packet's facts */
  facts: Map<string, { text: string; quote: string | null; dateText: string }>;
  /** short id -> existing observation text */
  observations: Map<string, { text: string }>;
}

const MIN_TEXT = 20;
const MAX_TEXT = 700;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Numbers as normalised tokens ("1,200" -> "1200", "2026-09-05" -> 2026, 09, 05). */
export function extractNumbers(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\d+(?:[.,]\d+)*/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    out.add(raw.replace(/,/g, ''));
    // also each segment, so "1.2.3" / "8443" / "10.0.0.1" components count
    for (const seg of raw.split(/[.,]/)) if (seg) out.add(seg.replace(/^0+(?=\d)/, '') || '0');
    out.add(raw.replace(/^0+(?=\d)/, '') || '0');
  }
  return out;
}

const NEGATION_RE = /\b(not|no|never|cannot|can't|won't|isn't|aren't|doesn't|don't|didn't|without|disabled?|removed?|deprecated)\b/i;
export const hasNegation = (t: string): boolean => NEGATION_RE.test(t);

/** Rough named-entity signature: capitalised words, hostnames, identifiers with digits. */
export function entitySignature(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b[A-Z][A-Za-z0-9_-]{2,}\b|\b[\w-]+\.[\w.-]*[a-z]{2,}\b|\b\w*\d\w*\b/g;
  for (const m of text.matchAll(re)) out.add(m[0].toLowerCase());
  return out;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));

/**
 * Near-duplicate guard (Hindsight: cosine ≥ 0.97 merge, but differences in
 * numbers, negations or named entities keep observations apart).
 */
export function isSafeNearDuplicate(a: string, b: string): boolean {
  if (hasNegation(a) !== hasNegation(b)) return false;
  if (!sameSet(extractNumbers(a), extractNumbers(b))) return false;
  if (!sameSet(entitySignature(a), entitySignature(b))) return false;
  return true;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(s => s.trim()) : [];
}

export function validateOps(
  raw: unknown, ctx: ValidationContext,
): { ops: ValidOp[]; rejected: Rejection[] } {
  const ops: ValidOp[] = [];
  const rejected: Rejection[] = [];
  const arr = Array.isArray(raw) ? raw as RawOp[] : [];
  const seenObs = new Set<string>(); // one op per observation per batch

  arr.forEach((r, index) => {
    const reject = (reason: string) => rejected.push({ index, reason });
    if (!r || typeof r !== 'object') return reject('not-object');
    const op = typeof r.op === 'string' ? r.op.trim().toLowerCase() : '';
    if (!['create', 'update', 'supersede', 'retire'].includes(op)) return reject('bad-op');
    const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (reason.length < 5) return reject('missing-reason');

    const obsRef = typeof r.obs === 'string' ? r.obs.trim() : null;
    if (op !== 'create') {
      if (!obsRef || !ctx.observations.has(obsRef)) return reject('unknown-observation');
      if (seenObs.has(obsRef)) return reject('duplicate-op-for-observation');
    }

    if (op === 'retire') {
      seenObs.add(obsRef!);
      ops.push({ op: 'retire', text: '', facet: null, subject: null, factRefs: [], obsRef, reason });
      return;
    }

    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (text.length < MIN_TEXT) return reject('text-too-short');
    if (text.length > MAX_TEXT) return reject('text-too-long');
    if (UUID_RE.test(text)) return reject('uuid-in-text');
    if (/^[\[{]/.test(text) || /"\s*:\s*"/.test(text)) return reject('json-in-text');

    const factRefs = [...new Set(strArray(r.facts))];
    if (factRefs.length === 0) return reject('no-facts-cited');
    if (factRefs.some(f => !ctx.facts.has(f))) return reject('unknown-fact');

    // Numbers may only come from the cited facts (text, quote, their dates)
    // or the observation being revised — "never calculate or derive numbers".
    const allowed = new Set<string>();
    for (const f of factRefs) {
      const fact = ctx.facts.get(f)!;
      for (const n of extractNumbers(`${fact.text} ${fact.quote ?? ''} ${fact.dateText}`)) allowed.add(n);
    }
    if (obsRef) for (const n of extractNumbers(ctx.observations.get(obsRef)!.text)) allowed.add(n);
    for (const n of extractNumbers(text)) {
      if (!allowed.has(n)) return reject(`invented-number:${n}`);
    }

    if (obsRef) seenObs.add(obsRef);
    ops.push({
      op: op as OpKind,
      text,
      facet: typeof r.facet === 'string' && r.facet.trim() ? r.facet.trim().slice(0, 80) : null,
      subject: typeof r.subject === 'string' && r.subject.trim() ? r.subject.trim().slice(0, 80) : null,
      factRefs, obsRef, reason,
    });
  });

  return { ops, rejected };
}
