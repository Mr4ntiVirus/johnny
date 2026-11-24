// Presentation rows for the doctor's KNOWLEDGE panel. One pure function feeds both
// the Ink TUI and the `--once` text fallback so they cannot drift apart.
import { C, age } from './stats.js';
import type { KnowledgeStats } from './knowledge-stats.js';

export interface KnowledgeSegment { text: string; color: string }
export interface KnowledgeRow { label: string; segments: KnowledgeSegment[] }

/** Value budget per row: half-width column (~46 cols) minus the 8-col label. Overflow is truncated, never wrapped. */
export const ROW_WIDTH = 38;

function fit(segments: KnowledgeSegment[], max = ROW_WIDTH): KnowledgeSegment[] {
  const out: KnowledgeSegment[] = [];
  let used = 0;
  for (const seg of segments) {
    if (used + seg.text.length <= max) { out.push(seg); used += seg.text.length; continue; }
    const room = max - used;
    if (room > 1) out.push({ ...seg, text: seg.text.slice(0, room - 1) + '…' });
    break;
  }
  return out;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export function knowledgeRows(k: KnowledgeStats | null): KnowledgeRow[] {
  if (!k) return [{ label: 'status', segments: [{ text: 'unavailable', color: C.dim }] }];

  const layers: KnowledgeRow = { label: 'layers', segments: [
    { text: `${k.facts}`, color: C.fg }, { text: ' facts → ', color: C.dim },
    { text: `${k.observations}`, color: C.fg }, { text: ' obs → ', color: C.dim },
    { text: `${k.models}`, color: C.cyan }, { text: ' models', color: C.dim },
  ] };

  const p = k.prime;
  const prime: KnowledgeRow = { label: 'prime', segments: [
    { text: `${p.day.primed}/${p.day.evaluated}`, color: p.day.primed > 0 ? C.cyan : C.dim },
    { text: ` 24h (${pct(p.day.primed, p.day.evaluated)}%)  `, color: C.dim },
    { text: `${p.week.primed}/${p.week.evaluated}`, color: p.week.primed > 0 ? C.fg : C.dim },
    { text: ' 7d', color: C.dim },
  ] };
  if (p.day.failed > 0) {
    prime.segments.push({ text: `  ${p.day.failed} failed`, color: C.red });
  }

  const s = k.synth;
  const synth: KnowledgeRow = { label: 'synth', segments: [] };
  const ran = s.lastRunAt ? age(s.lastRunAt) : 'never';
  const gated = s.lastRunStopped !== null && ['budget-day', 'budget-run', 'rate-limit', 'backoff', 'time-box'].includes(s.lastRunStopped);
  if (!s.armed) synth.segments.push({ text: '× not armed', color: C.red });
  else if (s.lastRunFailures > 0 && !s.lastRunProductive) {
    synth.segments.push({ text: `× failed ${ran} `, color: C.red });
    if (s.lastRunError) synth.segments.push({ text: s.lastRunError, color: C.red });
  } else if (s.lastRunFailures > 0) {
    // Partial: some work landed and the failed models retry themselves (6h cooldown).
    synth.segments.push({ text: '✓ armed ', color: C.green }, { text: `ran ${ran} ago · `, color: C.dim }, { text: `${s.lastRunFailures} retrying`, color: C.amber });
  } else if (gated) synth.segments.push({ text: `⏸ ${s.lastRunStopped} `, color: C.amber }, { text: ran, color: C.dim });
  else if (s.overdue) synth.segments.push({ text: '× stalled ', color: C.red }, { text: `last run ${ran}`, color: C.dim });
  else synth.segments.push({ text: '✓ armed ', color: C.green }, { text: s.lastRunAt ? `ran ${ran} ago` : 'no run yet', color: C.dim });
  if (s.paused.length) synth.segments.push({ text: `  paused: ${s.paused.join(',')}`, color: C.amber });
  if (s.backoffUntil) synth.segments.push({ text: '  backoff', color: C.amber });
  if (s.pendingMemories > 0 || s.staleModels > 0) {
    synth.segments.push({ text: `  ${s.pendingMemories} pend · ${s.staleModels} stale`, color: C.dim });
  }

  const v = k.verifier;
  const rej = v ? pct(v.unsupported, v.checked) : 0;
  const quality: KnowledgeRow = { label: 'quality', segments: [
    { text: `${k.disputedFacts}`, color: k.disputedFacts > 0 ? C.amber : C.dim }, { text: ' disputed', color: C.dim },
    ...(v ? [{ text: `  verifier ${rej}% rejected`, color: rej >= 30 ? C.amber : C.dim }] : []),
  ] };

  return [layers, prime, synth, quality].map(r => ({ ...r, segments: fit(r.segments) }));
}
