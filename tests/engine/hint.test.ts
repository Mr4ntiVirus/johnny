import { describe, it, expect } from 'vitest';
import { formatHint, type ScoredMemory, type FormatHintOptions } from '../../src/engine/hint.js';
import type { MemoryNode } from '../../src/types.js';

function makeMem(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: overrides.id ?? 'm1',
    snapshotName: overrides.snapshotName ?? 'rust-borrow-checker',
    title: overrides.title ?? 'Rust borrow checker',
    summary: overrides.summary ?? 'Rust borrow checker rejects code where the lifetime of a reference cannot be statically proven.',
    projectPath: '/tmp',
    tokenCount: 100,
    topics: overrides.topics ?? ['rust', 'lifetimes', 'borrow-checker'],
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: 1,
    createdAt: overrides.createdAt ?? '2026-04-12T10:00:00.000Z',
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0.15,
    rankUpdatedAtTurn: 0,
    ...overrides,
  };
}

const OPTS: FormatHintOptions = {
  highThreshold: 0.78,
  normalThreshold: 0.55,
};

describe('engine/hint formatHint — emission gate', () => {
  it('returns null on empty list', () => {
    expect(formatHint([], OPTS)).toBeNull();
  });

  it('returns null when top score < normalThreshold', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem(), score: 0.40 },
      { memory: makeMem({ id: 'm2', snapshotName: 'other' }), score: 0.35 },
    ];
    expect(formatHint(scored, OPTS)).toBeNull();
  });

  it('emits when top score crosses normalThreshold', () => {
    const scored: ScoredMemory[] = [{ memory: makeMem(), score: 0.60 }];
    const r = formatHint(scored, OPTS);
    expect(r).not.toBeNull();
  });
});

describe('engine/hint formatHint — selection rule', () => {
  it('top ≥ highThreshold → form3 (clear winner)', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'winner' }), score: 0.85 },
      { memory: makeMem({ id: 'm2', snapshotName: 'second' }), score: 0.62 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form3');
    expect(r.text).toContain('Top match');
    expect(r.text).toContain('Digest:');
    expect(r.text).toContain('winner');
  });

  it('top below high but 3+ within tolerance → form2 (titles only)', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'rust-a' }), score: 0.62 },
      { memory: makeMem({ id: 'm2', snapshotName: 'rust-b' }), score: 0.60 },
      { memory: makeMem({ id: 'm3', snapshotName: 'rust-c' }), score: 0.58 },
      { memory: makeMem({ id: 'm4', snapshotName: 'rust-d' }), score: 0.57 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form2');
    expect(r.text).toContain('Several memories');
    // Form 2 is title-only — must not contain field labels.
    expect(r.text).not.toContain('Confidence:');
    expect(r.text).not.toContain('Date:');
    expect(r.text).not.toContain('Summary:');
    expect(r.text).not.toContain('Digest:');
  });

  it('top below high, no cluster → form1 (structured summaries)', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'rust-a' }), score: 0.65 },
      { memory: makeMem({ id: 'm2', snapshotName: 'rust-b' }), score: 0.40 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form1');
    expect(r.text).toContain('Possibly relevant memories');
    expect(r.text).toContain('Title:');
    expect(r.text).toContain('Confidence:');
    expect(r.text).toContain('Summary:');
    // Sub-normal supplementals are filtered — "below normal → silent" applies
    // to every shown memory, not just the top. rust-b at 0.40 must NOT appear.
    expect(r.text).not.toContain('rust-b');
  });

  it('only one memory above threshold → form1 (no cluster requirement)', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'solo' }), score: 0.60 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form1');
    expect(r.text).toContain('solo');
  });

  it('three memories in cluster but one above high threshold → form3', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'top' }), score: 0.82 },
      { memory: makeMem({ id: 'm2', snapshotName: 'mid' }), score: 0.78 },
      { memory: makeMem({ id: 'm3', snapshotName: 'low' }), score: 0.74 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form3');
  });
});

describe('engine/hint formatHint — output shape', () => {
  it('output is prose, never JSON', () => {
    const scored: ScoredMemory[] = [{ memory: makeMem(), score: 0.85 }];
    const r = formatHint(scored, OPTS)!;
    expect(r.text.trim().startsWith('{')).toBe(false);
    expect(r.text.trim().startsWith('[')).toBe(false);
  });

  it('every emission ends with explicit MCP call instructions', () => {
    const variants: ScoredMemory[][] = [
      // form3
      [{ memory: makeMem(), score: 0.85 }],
      // form2 cluster
      [
        { memory: makeMem({ id: 'a', snapshotName: 'a' }), score: 0.62 },
        { memory: makeMem({ id: 'b', snapshotName: 'b' }), score: 0.60 },
        { memory: makeMem({ id: 'c', snapshotName: 'c' }), score: 0.58 },
      ],
      // form1
      [{ memory: makeMem(), score: 0.60 }],
    ];
    for (const scored of variants) {
      const r = formatHint(scored, OPTS)!;
      expect(r.text).toMatch(/johnny_recall/);
    }
  });

  it('form3 surfaces winner Digest body and supplemental Summaries', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'winner', summary: 'A specific winner summary.' }), score: 0.85 },
      { memory: makeMem({ id: 'm2', snapshotName: 'supp', summary: 'A supplemental summary.' }), score: 0.62 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.text).toContain('Digest: A specific winner summary');
    expect(r.text).toContain('Summary: A supplemental summary');
  });

  it('form3 with no supplementals omits the "also possibly" section', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'solo' }), score: 0.85 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.text).toContain('Digest:');
    expect(r.text).not.toContain('Also possibly relevant');
  });

  it('respects maxMemories cap (default 5)', () => {
    const scored: ScoredMemory[] = Array.from({ length: 8 }, (_, i) => ({
      memory: makeMem({ id: `m${i}`, snapshotName: `mem-${i}` }),
      score: 0.62 - i * 0.005,
    }));
    const r = formatHint(scored, OPTS)!;
    // Pick form2 with 8 same-cluster memories — it must show only top 5.
    expect(r.surfacedMemoryIds).toHaveLength(5);
    expect(r.text).toContain('mem-0');
    expect(r.text).not.toContain('mem-7');
  });

  it('honors maxMemories override', () => {
    const scored: ScoredMemory[] = Array.from({ length: 5 }, (_, i) => ({
      memory: makeMem({ id: `m${i}`, snapshotName: `mem-${i}` }),
      score: 0.62 - i * 0.005,
    }));
    const r = formatHint(scored, { ...OPTS, maxMemories: 2 })!;
    expect(r.surfacedMemoryIds).toHaveLength(2);
  });

  it('confidence label uses thresholds: high / medium / low', () => {
    const high: ScoredMemory[] = [{ memory: makeMem({ id: 'm1', snapshotName: 's1' }), score: 0.85 }];
    const med: ScoredMemory[] = [{ memory: makeMem({ id: 'm2', snapshotName: 's2' }), score: 0.60 }];
    expect(formatHint(high, OPTS)!.text).toMatch(/Confidence: high \(85%\)/);
    expect(formatHint(med, OPTS)!.text).toMatch(/Confidence: medium \(60%\)/);
  });

  it('shows Date as YYYY-MM-DD only', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ createdAt: '2026-04-12T10:30:42.123Z' }), score: 0.85 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.text).toContain('Date: 2026-04-12');
    expect(r.text).not.toContain('T10:30');
  });

  it('topics line shows "—" when memory has no topics', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ topics: [] }), score: 0.60 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.text).toContain('Topics: —');
  });

  it('returns surfacedMemoryIds matching displayed memories in order', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm-low', snapshotName: 's-low' }), score: 0.58 },
      { memory: makeMem({ id: 'm-high', snapshotName: 's-high' }), score: 0.82 },
      { memory: makeMem({ id: 'm-mid', snapshotName: 's-mid' }), score: 0.65 },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.surfacedMemoryIds).toEqual(['m-high', 'm-mid', 'm-low']);
  });
});

describe('engine/hint formatHint — edge cases', () => {
  it('skips entries with non-finite scores', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'good' }), score: 0.85 },
      // @ts-expect-error — testing defensive filter
      { memory: makeMem({ id: 'm2', snapshotName: 'bad' }), score: NaN },
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.text).toContain('good');
    expect(r.text).not.toContain('bad');
  });

  it('cluster tolerance is configurable', () => {
    // All three above normalThreshold so the supplemental filter doesn't drop
    // them — we're testing cluster width, not the emission gate.
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'a' }), score: 0.72 },
      { memory: makeMem({ id: 'm2', snapshotName: 'b' }), score: 0.62 },
      { memory: makeMem({ id: 'm3', snapshotName: 'c' }), score: 0.58 },
    ];
    // Tight tolerance — does NOT cluster, falls to form1.
    expect(formatHint(scored, { ...OPTS, clusterTolerance: 0.05 })!.form).toBe('form1');
    // Loose tolerance — clusters into form2.
    expect(formatHint(scored, { ...OPTS, clusterTolerance: 0.20 })!.form).toBe('form2');
  });

  it('two-memory case below high threshold falls to form1 (cluster needs 3)', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm1', snapshotName: 'a' }), score: 0.62 },
      { memory: makeMem({ id: 'm2', snapshotName: 'b' }), score: 0.61 },
    ];
    expect(formatHint(scored, OPTS)!.form).toBe('form1');
  });
});

describe('engine/hint formatHint — token budget', () => {
  // ~500-token cap is the hint emitter contract. ceil(chars/4) is the
  // estimator (matches engine/chunker). Worst case for each form must clear it.
  const longSummary =
    'This is a deliberately verbose summary that simulates a chatty memory recap, padded with detail and meandering sentences so the formatter is exercised against the 160-char two-line trim and the digest body in turn, then padded further so the budget test is meaningful instead of trivially under threshold.';

  function tokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  it('Form 1 with 5 long-summary memories stays under 500 tokens', () => {
    // Scores spread > clusterTolerance (0.10) across the top 3 so this lands
    // in form1, not form2 — but every score above normalThreshold so all 5 show.
    const spread = [0.77, 0.70, 0.65, 0.60, 0.56];
    const scored: ScoredMemory[] = spread.map((score, i) => ({
      memory: makeMem({ id: `m${i}`, snapshotName: `mem-${i}`, summary: longSummary }),
      score,
    }));
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form1');
    expect(tokens(r.text)).toBeLessThan(500);
  });

  it('Form 2 with 5 cluster memories stays under 500 tokens', () => {
    const scored: ScoredMemory[] = Array.from({ length: 5 }, (_, i) => ({
      memory: makeMem({ id: `m${i}`, snapshotName: `mem-${i}`, summary: longSummary }),
      score: 0.62 - i * 0.005,
    }));
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form2');
    expect(tokens(r.text)).toBeLessThan(500);
  });

  it('Form 3 with winner + 4 supplementals stays under 500 tokens', () => {
    const scored: ScoredMemory[] = [
      { memory: makeMem({ id: 'm0', snapshotName: 'winner', summary: longSummary }), score: 0.85 },
      ...Array.from({ length: 4 }, (_, i) => ({
        memory: makeMem({ id: `m${i + 1}`, snapshotName: `supp-${i}`, summary: longSummary }),
        score: 0.62,
      })),
    ];
    const r = formatHint(scored, OPTS)!;
    expect(r.form).toBe('form3');
    expect(tokens(r.text)).toBeLessThan(500);
  });
});
