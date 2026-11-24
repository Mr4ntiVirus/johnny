import { describe, it, expect } from 'vitest';
import { computeScore, RECOMMEND_THRESHOLD, OFFER_THRESHOLD } from '../../src/engine/scorer.js';

describe('scorer — CWD_BOOST suppression when isNewTopic', () => {
  it('CWD_BOOST suppressed when isNewTopic=true', () => {
    const r = computeScore(0, 0.488, null, [], false, true, { cwdChanged: true, longGap: false }, null);
    expect(r.score).toBeCloseTo(0.488);
  });

  it('CWD_BOOST applies when cwdChanged but isNewTopic=false', () => {
    const r = computeScore(0, 0.488, null, [], false, false, { cwdChanged: true, longGap: false }, null);
    expect(r.score).toBeCloseTo(0.634);  // 0.488 × 1.30
  });

  it('GAP_BOOST still applies when isNewTopic=true (long gap is not a new-topic signal)', () => {
    const r = computeScore(0, 0.488, null, [], false, true, { cwdChanged: false, longGap: true }, null);
    expect(r.score).toBeCloseTo(0.537);  // 0.488 × 1.10
  });
});

describe('scorer — embedder-offline clamp (Fix 1)', () => {
  it('caps score below RECOMMEND_THRESHOLD when embeddingScore=0, even with high keyword + cwd + llm switch', () => {
    const r = computeScore(1.0, 0, null, [], false, false, { cwdChanged: true, longGap: false }, 'switch');
    expect(r.score).toBeLessThan(RECOMMEND_THRESHOLD);
    expect(r.score).toBeCloseTo(RECOMMEND_THRESHOLD - 0.01);
    expect(r.score).toBeGreaterThanOrEqual(OFFER_THRESHOLD);
  });

  it('does not clamp when embeddingScore > 0, even if raw score would exceed RECOMMEND_THRESHOLD', () => {
    const r = computeScore(0, 0.75, null, [], false, false, { cwdChanged: true, longGap: false }, null);
    expect(r.score).toBeGreaterThan(RECOMMEND_THRESHOLD);
  });
});
