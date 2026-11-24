import { describe, it, expect } from 'vitest';
import { decide } from '../../src/engine/decision.js';
import { RECOMMEND_THRESHOLD, OFFER_THRESHOLD, MIN_HINT_COSINE } from '../../src/engine/scorer.js';
import type { DecisionContext, Action } from '../../src/types.js';

function ctx(overrides: Partial<DecisionContext>): DecisionContext {
  return {
    recallScore: 0,
    embeddingScore: MIN_HINT_COSINE,   // default: a raw match strong enough to be hinted (see 'weak raw match' suite)
    isAmbiguous: false,
    isTopicSwitch: false,
    contextPressure: 20,
    matchedMemory: null,
    candidates: [],
    currentTurn: 50,
    ...overrides,
  };
}

const mem = { id: 'm1', snapshotName: 'roku-auth' } as any;
const mem2 = { id: 'm2', snapshotName: 'vault-code' } as any;

describe('decide — recall actions', () => {
  it('high recallScore + matched memory → recommend_memory', () => {
    expect(decide(ctx({ recallScore: RECOMMEND_THRESHOLD, matchedMemory: mem }))).toBe('recommend_memory');
  });

  it('high recallScore + matched memory + high pressure → hard_switch', () => {
    expect(decide(ctx({ recallScore: RECOMMEND_THRESHOLD, matchedMemory: mem, contextPressure: 60 }))).toBe('hard_switch');
  });

  it('high recallScore + no matched memory → no recall (passthrough)', () => {
    expect(decide(ctx({ recallScore: RECOMMEND_THRESHOLD }))).toBe('passthrough');
  });

  it('offer band + matched memory → offer', () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD, matchedMemory: mem }))).toBe('offer');
  });

  it('offer band + no matched memory → passthrough', () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD }))).toBe('passthrough');
  });

  it('below offer threshold → passthrough regardless of memory', () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD - 0.01, matchedMemory: mem }))).toBe('passthrough');
  });

  it('ambiguous + 2 candidates + offer threshold → suggest_memories', () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD, isAmbiguous: true, candidates: [mem, mem2] }))).toBe('suggest_memories');
  });

  it('ambiguous + only 1 candidate → not suggest (no blend)', () => {
    const action = decide(ctx({ recallScore: OFFER_THRESHOLD, isAmbiguous: true, candidates: [mem] }));
    expect(action).not.toBe('suggest_memories');
  });

  it('ambiguous below offer threshold → passthrough', () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD - 0.01, isAmbiguous: true, candidates: [mem, mem2] }))).toBe('passthrough');
  });
});

describe('decide — context-pressure gating', () => {
  it('low recall + low pressure → passthrough', () => {
    expect(decide(ctx({ recallScore: 0, contextPressure: 20 }))).toBe('passthrough');
  });

  it('low recall + high pressure → snapshot_passthrough', () => {
    expect(decide(ctx({ recallScore: 0, contextPressure: 80 }))).toBe('snapshot_passthrough');
  });
});

describe('decide — trim is post-turn-only, never returned from decide()', () => {
  const pressureCases = [0, 30, 60, 90, 100];

  for (const contextPressure of pressureCases) {
    it(`contextPressure=${contextPressure} never returns trim`, () => {
      const action = decide(ctx({ recallScore: 0, matchedMemory: mem, contextPressure }));
      expect(action).not.toBe('trim');
    });
  }

  it('high recall + high pressure still does not trim', () => {
    expect(decide(ctx({ recallScore: 0.9, matchedMemory: mem, contextPressure: 90 }))).not.toBe('trim');
  });
});

describe('decide — isTopicSwitch Gate 1', () => {
  it('isTopicSwitch + no matched memory → passthrough (no destructive reset)', () => {
    expect(decide(ctx({ isTopicSwitch: true, matchedMemory: null, recallScore: 0 }))).toBe('passthrough');
  });

  it('isTopicSwitch + no matched memory + high pressure → snapshot_passthrough', () => {
    expect(decide(ctx({ isTopicSwitch: true, matchedMemory: null, recallScore: 0, contextPressure: 80 }))).toBe('snapshot_passthrough');
  });

  it('isTopicSwitch + weak match (offer band) → recommend_memory, not offer', () => {
    expect(decide(ctx({ isTopicSwitch: true, matchedMemory: mem, recallScore: OFFER_THRESHOLD }))).toBe('recommend_memory');
  });

  it('isTopicSwitch + strong match → hard_switch', () => {
    expect(decide(ctx({ isTopicSwitch: true, matchedMemory: mem, recallScore: RECOMMEND_THRESHOLD }))).toBe('hard_switch');
  });
});

describe('decide — threshold boundaries', () => {
  it(`score exactly at RECOMMEND_THRESHOLD (${RECOMMEND_THRESHOLD}) fires recommend`, () => {
    expect(decide(ctx({ recallScore: RECOMMEND_THRESHOLD, matchedMemory: mem }))).toBe('recommend_memory');
  });

  it(`score just below RECOMMEND_THRESHOLD fires offer (not recommend)`, () => {
    expect(decide(ctx({ recallScore: RECOMMEND_THRESHOLD - 0.001, matchedMemory: mem }))).toBe('offer');
  });

  it(`score exactly at OFFER_THRESHOLD (${OFFER_THRESHOLD}) fires offer`, () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD, matchedMemory: mem }))).toBe('offer');
  });

  it(`score just below OFFER_THRESHOLD → passthrough`, () => {
    expect(decide(ctx({ recallScore: OFFER_THRESHOLD - 0.001, matchedMemory: mem }))).toBe('passthrough');
  });
});

describe('decide — weak raw match is hidden (2026-10-13)', () => {
  it('boosted score over threshold but raw cosine below the floor → passthrough', () => {
    // real case: raw 0.62 + LLM new-topic vote 0.15 = 0.77 used to recommend an unrelated memory
    expect(decide(ctx({ recallScore: 0.77, embeddingScore: 0.62, isTopicSwitch: true, matchedMemory: mem }))).toBe('passthrough');
  });

  it('weak raw match does not suggest_memories either', () => {
    expect(decide(ctx({ recallScore: 0.7, embeddingScore: 0.6, isAmbiguous: true, candidates: [mem, mem2] }))).toBe('passthrough');
  });

  it('embedder offline (raw 0) never hints on keyword score alone', () => {
    expect(decide(ctx({ recallScore: 0.69, embeddingScore: 0, matchedMemory: mem }))).toBe('passthrough');
  });

  it('weak match under high context pressure still snapshots, never hints', () => {
    expect(decide(ctx({ recallScore: 0.8, embeddingScore: 0.6, matchedMemory: mem, contextPressure: 75 }))).toBe('snapshot_passthrough');
  });

  it('a raw match at the floor still recommends', () => {
    expect(decide(ctx({ recallScore: 0.8, embeddingScore: MIN_HINT_COSINE, matchedMemory: mem }))).toBe('recommend_memory');
  });
});

describe('decide — topic-switch light tier (raw 0.65-0.75: digest only)', () => {
  const lowRaw = (o: object) => ctx({ isTopicSwitch: true, matchedMemory: mem, recallScore: RECOMMEND_THRESHOLD + 0.1, embeddingScore: 0.66, ...o });
  it('switch + matched memory + raw 0.66 → offer (digest only, never a transcript append)', () => {
    expect(decide(lowRaw({}))).toBe('offer');
  });
  it('same raw 0.66 on a NON-switch turn stays hidden', () => {
    expect(decide(lowRaw({ isTopicSwitch: false }))).toBe('passthrough');
  });
  it('switch with raw 0.60 (below the switch floor) stays hidden', () => {
    expect(decide(lowRaw({ embeddingScore: 0.60 }))).toBe('passthrough');
  });
  it('switch with raw >= 0.75 keeps the full path (hard_switch, demoted to recommend_memory by the gate)', () => {
    expect(decide(lowRaw({ embeddingScore: 0.76 }))).toBe('hard_switch');
  });
  it('light tier never produces suggest_memories or recommend_memory from the generic branches', () => {
    expect(decide(lowRaw({ isAmbiguous: true, candidates: [mem, mem], recallScore: OFFER_THRESHOLD - 0.01 }))).toBe('passthrough');
  });
  it('light tier with no usable boosted score still snapshots under pressure', () => {
    expect(decide(lowRaw({ recallScore: 0.3, contextPressure: 80 }))).toBe('snapshot_passthrough');
  });
});
