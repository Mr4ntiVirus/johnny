import { describe, it, expect } from 'vitest';
import { knowledgeRows, ROW_WIDTH } from '../../src/store/knowledge-view.js';
import { C } from '../../src/store/stats.js';
import type { KnowledgeStats } from '../../src/store/knowledge-stats.js';

const w = (evaluated = 0, primed = 0, failed = 0) => ({ evaluated, primed, failed });
const base = (over: Partial<KnowledgeStats['synth']> = {}, prime: Partial<KnowledgeStats['prime']> = {}): KnowledgeStats => ({
  facts: 8037, observations: 2895, models: 78, disputedFacts: 178,
  prime: { hour: w(), day: w(48, 12), week: w(210, 51), lastEventAt: null, lastFailureAt: null, lastError: null, ...prime },
  synth: { armed: true, lastRunAt: new Date().toISOString(), lastRunStopped: 'done', lastRunFailures: 0, lastRunProductive: true, lastRunError: null, overdue: false,
    pendingMemories: 0, staleModels: 0, paused: [], backoffUntil: null, ...over },
  verifier: { checked: 35, unsupported: 12 },
});
const text = (k: KnowledgeStats | null) => knowledgeRows(k).map(r => `${r.label}|${r.segments.map(s => s.text).join('')}`);
const synthSeg = (k: KnowledgeStats) => knowledgeRows(k).find(r => r.label === 'synth')!.segments;

describe('knowledgeRows', () => {
  it('never exceeds the row width budget (no wrapping in the half-width panel)', () => {
    const worst = base({ lastRunStopped: 'budget-day', paused: ['extract', 'consolidate'], backoffUntil: 'x', pendingMemories: 3981, staleModels: 78 });
    for (const r of knowledgeRows(worst)) expect(r.segments.map(s => s.text).join('').length).toBeLessThanOrEqual(ROW_WIDTH);
  });

  it('shows layers, prime rate and quality', () => {
    const rows = text(base());
    expect(rows[0]).toBe('layers|8037 facts → 2895 obs → 78 models');
    expect(rows[1]).toBe('prime|12/48 24h (25%)  51/210 7d');
    expect(rows[3]).toBe('quality|178 disputed  verifier 34% rejected');
  });

  it('is explicit when the snapshot is unavailable', () => {
    expect(text(null)).toEqual(['status|unavailable']);
  });

  it('flags priming failures in red', () => {
    const k = base({}, { day: w(48, 12, 2) });
    const prime = knowledgeRows(k)[1];
    const fail = prime.segments.find(s => s.text.includes('failed'))!;
    expect(fail.text.trim()).toBe('2 failed');
    expect(fail.color).toBe(C.red);
  });

  it('judges the heartbeat: healthy, gated, failed, stalled, unarmed', () => {
    expect(synthSeg(base())[0].color).toBe(C.green);
    expect(synthSeg(base({ lastRunStopped: 'budget-day' }))[0]).toMatchObject({ color: C.amber });
    const failed = synthSeg(base({ lastRunFailures: 6, lastRunProductive: false, lastRunError: 'claude exited 1: Not logged in' }));
    expect(failed[0].color).toBe(C.red);
    expect(failed.map(s => s.text).join('')).toContain('claude exited 1');
    expect(synthSeg(base({ overdue: true }))[0].text).toContain('stalled');
    expect(synthSeg(base({ armed: false }))[0].text).toContain('not armed');
  });

  it('a failed run outranks a "done" label', () => {
    expect(synthSeg(base({ lastRunStopped: 'done', lastRunFailures: 1, lastRunProductive: false }))[0].color).toBe(C.red);
  });

  it('a run that failed on one model but still produced work is a quiet retry, not red', () => {
    const seg = synthSeg(base({ lastRunStopped: 'done', lastRunFailures: 1, lastRunProductive: true }));
    expect(seg[0].color).toBe(C.green);
    expect(seg.map(s => s.text).join('')).toContain('retrying');
  });
});
