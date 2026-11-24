// Automatic priming: the "subconscious" read path.
//
// On a UserPromptSubmit turn the hook already has the prompt embedding. Here we
// score it against the small, precompiled set of active models and observations
// and, when a trusted item is relevant and not recently surfaced, emit a short
// distilled digest. No LLM on this path — everything it reads was compiled and
// verified by the background synthesis job.
//
// Trust gates (automatic push means errors spread automatically):
//   * observations need >= primeMinProof DISTINCT SESSIONS, not disputed, not rejected
//   * models must have verified content (only ever written after verification)
//   * a stale model is primed only if recent, and says so
//   * nothing is primed that CLAUDE.md / MEMORY.md for this cwd already carries
//   * per-session cooldown (reuses the memory cooldown logic) — never the same item twice in a row

import { searchKnowledge, type KnowledgeHit } from './retrieve.js';
import { scopeForProject } from './windows.js';
import { loadedContextText, isAlreadyLoaded } from './loaded-context.js';
import { isInCooldown } from '../engine/cooldown.js';
import { getSurfacedMap, setMemorySurfaced } from '../store/db/sessions.js';
import type { KnowledgeConfig } from '../types.js';

export type PrimeTrigger = 'first-prompt' | 'topic-switch' | 'post-compact' | 'continuation' | 'tool';

export interface PrimeResult {
  additionalContext: string;
  refs: string[];
  topScore: number;
}

/** Why each candidate was or wasn't primed (diagnostics for `johnny eval-prime`). */
export interface PrimeTrace { ref: string; kind: string; similarity: number; verdict: string }

const STALE_MODEL_MAX_AGE_DAYS = 14;
// One digest per trigger: with a large compiled base, several near-equal items are usually the
// same knowledge at different levels (an observation plus the model that contains it).
const MAX_ITEMS = 1;
/** A second primed item must score within this margin of the first (no unrelated ride-alongs). */
export const SECOND_ITEM_MARGIN = 0.06;

const dayOf = (iso: string) => iso.slice(0, 10);

/** Pick the model sections that best match the prompt, within a character budget. */
export function selectRelevantSections(content: string, promptText: string, maxChars: number): string {
  if (content.length <= maxChars) return content.trim();
  const parts = content.split(/\n(?=##\s)/);
  if (parts.length === 1) return content.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  const promptTokens = new Set(promptText.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{3,}/g) ?? []);
  const scored = parts.map((p, i) => {
    const toks = p.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{3,}/g) ?? [];
    let overlap = 0;
    for (const t of new Set(toks)) if (promptTokens.has(t)) overlap++;
    return { p: p.trim(), i, overlap };
  });
  // Keep the document title/intro (first part) only if there is room after the best sections.
  const ordered = [...scored].sort((a, b) => b.overlap - a.overlap || a.i - b.i);
  const chosen: typeof scored = [];
  let used = 0;
  for (const s of ordered) {
    if (used + s.p.length + 2 > maxChars) {
      if (chosen.length === 0) { chosen.push({ ...s, p: s.p.slice(0, maxChars).replace(/\s+\S*$/, '') + '…' }); used = maxChars; }
      continue;
    }
    chosen.push(s);
    used += s.p.length + 2;
  }
  return chosen.sort((a, b) => a.i - b.i).map(c => c.p).join('\n\n');
}

/** Date an observation's claim is true "as of": an explicit "As of YYYY-MM-DD" in its text, else null. */
export function claimDate(text: string): string | null {
  const m = /\bas of (\d{4}-\d{2}-\d{2})\b/i.exec(text);
  return m ? m[1] : null;
}

/** Margin below the primed observation's similarity a newer fact may score and still count as "same subject". */
export const NEWER_FACT_MARGIN = 0.05;
const MAX_NEWER_FACTS = 3;

/**
 * Observations are compiled snapshots and can go stale without ever being superseded (the consolidator only
 * sees contradictions inside one scope/facet). Before priming a DATED observation, look for facts about the
 * same subject that were mentioned after its "as of" date and hand them over alongside it.
 */
export function pickNewerFacts(obs: KnowledgeHit, facts: KnowledgeHit[]): KnowledgeHit[] {
  const since = claimDate(obs.text);
  if (!since) return [];
  return facts
    .filter(f => f.kind === 'fact' && dayOf(f.asOf) > since && f.similarity >= obs.similarity - NEWER_FACT_MARGIN)
    // Newest first: the point is to correct a stale snapshot, so recency beats a slightly higher cosine.
    .sort((a, b) => b.asOf.localeCompare(a.asOf) || b.similarity - a.similarity)
    .slice(0, MAX_NEWER_FACTS);
}

export function formatDigest(hits: KnowledgeHit[], promptText: string, maxChars: number, newer: KnowledgeHit[] = []): string {
  const perItem = Math.floor(maxChars / Math.max(1, hits.length));
  const blocks = hits.map(h => {
    if (h.kind === 'model') {
      const note = h.stale ? ' (may be slightly out of date — newer notes exist)' : '';
      // The section that matched the prompt (embedding), else best token-overlap sections.
      const body = h.focus ? (h.focus.length > perItem ? selectRelevantSections(h.focus, promptText, perItem) : h.focus)
        : selectRelevantSections(h.text, promptText, perItem);
      return `• ${h.title} (compiled ${dayOf(h.asOf)}${note}):\n${body}`;
    }
    const sessions = h.proof === 1 ? '1 session' : `${h.proof} sessions`;
    return `• ${h.text.trim()} (confirmed across ${sessions}, last updated ${dayOf(h.asOf)})`;
  });
  if (newer.length > 0) {
    blocks.push(`• NEWER notes about the same subject (these supersede the dated note above wherever they differ):\n` +
      newer.map(f => `  - ${f.text.trim()} (noted ${dayOf(f.asOf)})`).join('\n'));
  }
  return [
    `Johnny recalled this from your long-term memory (compiled and verified in the background):`,
    ...blocks,
    `For the evidence behind this or to dig deeper, use johnny_reflect or johnny_models.`,
  ].join('\n');
}

export function isPrimeEligible(h: KnowledgeHit, cfg: KnowledgeConfig, nowMs = Date.now()): boolean {
  if (h.disputed || !h.verified) return false;
  if (h.kind === 'observation') return h.proof >= cfg.primeMinProof;
  if (h.kind === 'model') {
    if (!h.stale) return true;
    const age = (nowMs - Date.parse(h.asOf)) / 86_400_000;
    return age <= STALE_MODEL_MAX_AGE_DAYS;
  }
  return false; // raw facts are introspection-only; priming uses compiled layers
}

export async function computePrime(opts: {
  promptEmbedding: number[];
  promptText: string;
  cwd: string;
  sessionId: string;
  turn: number;
  trigger: PrimeTrigger;
  config: KnowledgeConfig;
  /** Evaluate only: read nothing from / write nothing to the per-session surfaced map. */
  dryRun?: boolean;
  /** With dryRun: the caller's own surfaced map (ref → turn), so a replay can model once-per-epoch. */
  surfaced?: Record<string, number>;
  /** Receives one entry per considered candidate (diagnostics). */
  trace?: PrimeTrace[];
}): Promise<PrimeResult | null> {
  const { config: cfg } = opts;
  if (!cfg.prime) return null;

  const minSim = opts.trigger === 'tool' ? cfg.primeToolSimilarity
    : opts.trigger === 'continuation' ? cfg.primeContinuationSimilarity : cfg.primeMinSimilarity;
  const scope = scopeForProject(opts.cwd);
  // The tool trigger fires on every shell command, so it scans the (few) models only.
  const hits = await searchKnowledge(opts.promptEmbedding, {
    scope, kinds: opts.trigger === 'tool' ? ['model'] : ['model', 'observation'],
    limit: 8, minSimilarity: minSim, withStaleness: true,
  });
  if (hits.length === 0) return null;

  const surfaced = opts.dryRun ? (opts.surfaced ?? {}) : await getSurfacedMap(opts.sessionId);
  const loaded = loadedContextText(opts.cwd);
  // Strict once-per-context-epoch: unlike memory offers, a bullseye match must NOT
  // re-inject the same digest (that would repeat identical text every turn). Items
  // become eligible again only when compaction clears them from context
  // (clearKnowledgeSurfaced, called by the post-compact hook).
  const gate = { cooldownTurns: Number.POSITIVE_INFINITY, subjectShiftThreshold: 2 };

  const chosen: KnowledgeHit[] = [];
  const note = (h: KnowledgeHit, verdict: string) => opts.trace?.push({ ref: h.ref, kind: h.kind, similarity: h.similarity, verdict });
  for (const h of hits) {
    if (chosen.length >= MAX_ITEMS) { note(h, 'skipped: enough items'); continue; }
    if (!isPrimeEligible(h, cfg)) { note(h, 'rejected: trust gate'); continue; }
    if (isInCooldown(h.ref, h.similarity, { surfacedMap: surfaced, currentTurn: opts.turn }, gate)) { note(h, 'rejected: already surfaced'); continue; }
    if (isAlreadyLoaded(h.text, loaded)) { note(h, 'rejected: already in CLAUDE.md/MEMORY.md'); continue; }
    // Don't prime an observation that the chosen model already covers.
    if (h.kind === 'observation' && chosen.some(c => c.kind === 'model' && c.text.includes(h.text.slice(0, 40)))) { note(h, 'rejected: covered by chosen model'); continue; }
    // No unrelated ride-alongs: a second item must be nearly as relevant as the first.
    if (chosen.length > 0 && h.similarity < chosen[0].similarity - SECOND_ITEM_MARGIN) { note(h, 'rejected: not close enough to the top item'); continue; }
    chosen.push(h);
    note(h, chosen.length === 1 ? 'PRIMED (top)' : 'PRIMED (second)');
  }
  if (chosen.length === 0) return null;

  // Dated observations may be stale: attach newer facts on the same subject (non-tool triggers only; scans facts).
  let newer: KnowledgeHit[] = [];
  if (opts.trigger !== 'tool' && chosen[0].kind === 'observation' && claimDate(chosen[0].text)) {
    const facts = await searchKnowledge(opts.promptEmbedding, { scope, kinds: ['fact'], limit: 40, minSimilarity: minSim - NEWER_FACT_MARGIN });
    newer = pickNewerFacts(chosen[0], facts);
    for (const f of newer) opts.trace?.push({ ref: f.ref, kind: f.kind, similarity: f.similarity, verdict: 'attached: newer than dated observation' });
  }

  if (!opts.dryRun) for (const h of chosen) await setMemorySurfaced(opts.sessionId, h.ref, opts.turn);
  return {
    additionalContext: formatDigest(chosen, opts.promptText, cfg.primeMaxChars, newer),
    refs: [...chosen, ...newer].map(h => h.ref),
    topScore: chosen[0].similarity,
  };
}
