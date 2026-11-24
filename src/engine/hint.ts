// Phase G.5 — Hint emitter. Pure formatter that produces additionalContext
// prose for the two-trigger confidence ladder (hint + recommend_memory unified).
//
// Design ground truth: project_johnny_phase_g_design.md (locked 2026-04-25).
// - Output is prose with colon-headed fields, never JSON. Audience is Claude.
// - Three forms selected by confidence shape:
//     Form 3: top score ≥ highThreshold → winner Digest + supplemental Summaries
//     Form 2: top < high AND ≥3 memories cluster within clusterTolerance → titles only
//     Form 1: otherwise → structured Summary blocks for each memory
// - Always end with explicit MCP call instructions ("call johnny_recall …").
// - Cap at maxMemories (default 5) — Claude's attention is the constraint, not bytes.
// - Surfaced-memories cooldown filtering is the caller's job. The emitter
//   formats whatever scored list you hand it.
//
// Pure module: no I/O, no DB, no clock. Tests can drive it deterministically.

import type { MemoryNode } from '../types.js';

export interface ScoredMemory {
  memory: MemoryNode;
  // 0..1 cosine similarity vs. the prompt, or null when the caller has a
  // confidence label but no real number (heuristic-only recommend_memory, ask
  // resolution). Null entries always pass the emission gate — they're emitted
  // by-policy, not by score — and render `Confidence: <label>` without a
  // percentage. Never synthesize a fake percentage to satisfy the type.
  score: number | null;
  // Explicit confidence label when score is null. Required if score is null,
  // ignored otherwise (we derive the label from the score).
  label?: 'high' | 'medium' | 'low';
}

export interface FormatHintOptions {
  highThreshold: number;       // ≥ this → Form 3
  normalThreshold: number;     // ≥ this → emit at all (else null)
  maxMemories?: number;        // cap on shown memories (default 5)
  clusterTolerance?: number;   // Form 2 cluster window in score units (default 0.10)
}

export type HintForm = 'form1' | 'form2' | 'form3';

export interface HintEmission {
  form: HintForm;
  text: string;
  surfacedMemoryIds: string[];  // ids the caller should add to surfaced_memories
}

const DEFAULT_MAX_MEMORIES = 5;
const DEFAULT_CLUSTER_TOLERANCE = 0.10;

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function labelFor(sm: ScoredMemory, opts: FormatHintOptions): 'high' | 'medium' | 'low' {
  if (sm.score === null) return sm.label ?? 'medium';
  if (sm.score >= opts.highThreshold) return 'high';
  if (sm.score >= opts.normalThreshold) return 'medium';
  return 'low';
}

function confidenceLine(sm: ScoredMemory, opts: FormatHintOptions): string {
  const label = labelFor(sm, opts);
  return sm.score === null
    ? `Confidence: ${label}`
    : `Confidence: ${label} (${pct(sm.score)})`;
}

function dateOnly(iso: string): string {
  // createdAt is an ISO timestamp; show YYYY-MM-DD only.
  return (iso ?? '').slice(0, 10);
}

// Trim summary to ~2 visual lines (~160 chars, sentence-aware where cheap).
function twoLineSummary(summary: string): string {
  const s = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '(no summary)';
  if (s.length <= 160) return s;
  const cut = s.slice(0, 157);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// Form 3's Digest is a longer, wrapped take on the summary. We don't have a
// pre-baked "digest" field on MemoryNode — and we don't pull the transcript
// here (that's johnny_recall's job). The Digest is whatever full summary the
// memory carries. Topics + date are surfaced separately above.
function digestBody(mem: MemoryNode): string {
  const s = (mem.summary ?? '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '(no summary recorded)';
  return s;
}

function memoryBlockForm1(sm: ScoredMemory, opts: FormatHintOptions): string {
  const m = sm.memory;
  const topics = m.topics.length > 0 ? m.topics.slice(0, 8).join(', ') : '—';
  return [
    `Title: ${m.snapshotName}`,
    `Topics: ${topics}`,
    confidenceLine(sm, opts),
    `Date: ${dateOnly(m.createdAt)}`,
    `Summary: ${twoLineSummary(m.summary)}`,
  ].join('\n');
}

function memoryBlockForm3Winner(sm: ScoredMemory, opts: FormatHintOptions): string {
  const m = sm.memory;
  const topics = m.topics.length > 0 ? m.topics.slice(0, 8).join(', ') : '—';
  return [
    `Title: ${m.snapshotName}`,
    `Topics: ${topics}`,
    confidenceLine(sm, opts),
    `Date: ${dateOnly(m.createdAt)}`,
    `Digest: ${digestBody(m)}`,
  ].join('\n');
}

function memoryBlockForm3Supplemental(sm: ScoredMemory, opts: FormatHintOptions): string {
  // Supplementals get summary-only, same fields as Form 1 minus the digest.
  return memoryBlockForm1(sm, opts);
}

// Call instructions are emitter-pure: they describe what Claude can do, never
// what has already happened. The hint emitter does not perform any I/O — it
// only formats prose. Soft-switch (Phase G.6) and bootstrap (Phase G.7) are
// the actions that actually load context; if they want to assert load state,
// they layer their own confirmation line on top of the emitter output.
const CALL_INSTRUCTIONS_HINT =
  'Call johnny_recall now on whichever of these names looks most relevant, before responding — ' +
  'the summaries above are not enough to act on by themselves. Use johnny_search first only if none of these look right.';

const CALL_INSTRUCTIONS_FORM3 =
  'Call johnny_recall now on the top match before responding — do not rely on the digest alone.';

function formatForm1(scored: ScoredMemory[], opts: FormatHintOptions): string {
  const blocks = scored.map(sm => memoryBlockForm1(sm, opts));
  return [
    'Possibly relevant memories:',
    '',
    blocks.join('\n\n'),
    '',
    CALL_INSTRUCTIONS_HINT,
  ].join('\n');
}

function formatForm2(scored: ScoredMemory[]): string {
  const lines = scored.map(sm =>
    sm.score === null
      ? `  ${sm.memory.snapshotName}`
      : `  ${sm.memory.snapshotName}  (${pct(sm.score)})`,
  );
  // Aggregate up to ~10 unique topics across the cluster — gives Claude the
  // landscape without a per-memory expansion.
  const topicSet = new Set<string>();
  for (const sm of scored) {
    for (const t of sm.memory.topics) {
      topicSet.add(t);
      if (topicSet.size >= 10) break;
    }
    if (topicSet.size >= 10) break;
  }
  const topicsLine = topicSet.size > 0 ? `Topics: ${Array.from(topicSet).join(', ')}` : null;
  const out: string[] = ['Several memories may be relevant:', '', ...lines];
  if (topicsLine) out.push('', topicsLine);
  out.push('', CALL_INSTRUCTIONS_HINT);
  return out.join('\n');
}

function formatForm3(scored: ScoredMemory[], opts: FormatHintOptions): string {
  const [winner, ...rest] = scored;
  const winnerBlock = memoryBlockForm3Winner(winner, opts);
  const out: string[] = ['Top match — most relevant memory:', '', winnerBlock];
  if (rest.length > 0) {
    out.push('', 'Also possibly relevant:', '');
    out.push(rest.map(sm => memoryBlockForm3Supplemental(sm, opts)).join('\n\n'));
  }
  out.push('', CALL_INSTRUCTIONS_FORM3);
  return out.join('\n');
}

// Decide which form fits the score distribution and emit it. Returns null when
// nothing crosses the normal threshold (silent — caller emits no hint).
export function formatHint(
  scored: ScoredMemory[],
  opts: FormatHintOptions,
): HintEmission | null {
  if (!Array.isArray(scored) || scored.length === 0) return null;

  const maxMems = opts.maxMemories ?? DEFAULT_MAX_MEMORIES;
  const clusterTol = opts.clusterTolerance ?? DEFAULT_CLUSTER_TOLERANCE;

  // Null scores are by-policy emissions (recommend_memory, ask resolution): the
  // caller has a confidence label but no real number. Sort them to the top
  // (Infinity) so the winner-by-policy lands first; pass the score gate by
  // skipping the numeric comparison.
  const scoreFor = (s: ScoredMemory) => (s.score === null ? Infinity : s.score);
  const sorted = [...scored]
    .filter(s => s && s.memory && (s.score === null || Number.isFinite(s.score)))
    .sort((a, b) => scoreFor(b) - scoreFor(a))
    .slice(0, maxMems)
    // "Below normal → silent" applies to every shown memory, not only the top.
    // Supplementals carrying "Confidence: low (40%)" labels would contradict the
    // emission contract, so we filter them out here too. Null-score entries
    // bypass the gate — they're emitted by-policy, not by score.
    .filter(s => s.score === null || s.score >= opts.normalThreshold);

  if (sorted.length === 0) return null;
  const top = sorted[0];

  // Form 3: clear winner above the high threshold, OR a by-policy entry (null
  // score) — recommend_memory and ask resolution always render Form 3.
  if (top.score === null || top.score >= opts.highThreshold) {
    return {
      form: 'form3',
      text: formatForm3(sorted, opts),
      surfacedMemoryIds: sorted.map(s => s.memory.id),
    };
  }

  // Form 2: ≥3 memories cluster within clusterTolerance of the top score.
  // Skipped when any of the top 3 is by-policy (null) — clustering is a
  // numeric judgement.
  if (sorted.length >= 3) {
    const top3 = sorted.slice(0, 3);
    if (top3.every(s => s.score !== null)) {
      const spread = (top3[0].score as number) - (top3[top3.length - 1].score as number);
      if (spread <= clusterTol) {
        return {
          form: 'form2',
          text: formatForm2(sorted),
          surfacedMemoryIds: sorted.map(s => s.memory.id),
        };
      }
    }
  }

  // Form 1: structured summaries.
  return {
    form: 'form1',
    text: formatForm1(sorted, opts),
    surfacedMemoryIds: sorted.map(s => s.memory.id),
  };
}
