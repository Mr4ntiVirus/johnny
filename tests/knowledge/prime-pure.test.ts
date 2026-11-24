import { describe, it, expect } from 'vitest';
import { selectRelevantSections, formatDigest, isPrimeEligible } from '../../src/knowledge/prime.js';
import { coverage, isAlreadyLoaded, keyTokens } from '../../src/knowledge/loaded-context.js';
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/knowledge/config.js';
import { boost, proofSignal, recencySignal } from '../../src/knowledge/retrieve.js';
import type { KnowledgeHit } from '../../src/knowledge/retrieve.js';

const cfg = { ...DEFAULT_KNOWLEDGE_CONFIG, prime: true };
const hit = (o: Partial<KnowledgeHit>): KnowledgeHit => ({
  kind: 'observation', ref: 'obs:1', title: 't', text: 'The relay listens on port 8443.', scope: 'global',
  score: 0.8, similarity: 0.8, asOf: '2026-10-10T00:00:00Z', stale: false, proof: 3, disputed: false, verified: true, ...o,
});

describe('selectRelevantSections', () => {
  const doc = [
    '# Relay',
    'intro line',
    '## Network\nThe relay listens on port 8443 behind mutual TLS at relay.example.com.',
    '## Database\nPostgres runs on a managed instance db-primary and hibernates when idle.',
    '## Cost\nThe t3.micro box costs little and also hosts Navidrome music streaming.',
  ].join('\n');

  it('returns the whole document when it fits', () => {
    expect(selectRelevantSections(doc, 'anything', 5000)).toBe(doc.trim());
  });
  it('keeps the sections that overlap the prompt, in document order, within budget', () => {
    const out = selectRelevantSections(doc, 'which port does the relay use for mutual TLS', 140);
    expect(out).toContain('port 8443');
    expect(out).not.toContain('Navidrome');
    expect(out.length).toBeLessThanOrEqual(160);
  });
  it('truncates a single oversized section on a word boundary', () => {
    const long = '## Only\n' + 'word '.repeat(500);
    const out = selectRelevantSections(long, 'word', 100);
    expect(out.length).toBeLessThanOrEqual(110);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('formatDigest', () => {
  it('is prose with provenance, never JSON', () => {
    const d = formatDigest([
      hit({ kind: 'model', title: 'Relay model', text: '## Network\nPort 8443 mTLS.', stale: true }),
      hit({ kind: 'observation', proof: 4 }),
    ], 'relay port', 1200);
    expect(d).toContain('Johnny recalled this from your long-term memory');
    expect(d).toContain('Relay model (compiled 2026-10-10');
    expect(d).toContain('may be slightly out of date');
    expect(d).toContain('confirmed across 4 sessions');
    expect(d).toContain('johnny_reflect');
    expect(d).not.toMatch(/^\s*[{[]/m);
  });
});

describe('isPrimeEligible (trust gates)', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  it('observations need enough distinct sessions and must not be disputed/rejected', () => {
    expect(isPrimeEligible(hit({ proof: 1 }), cfg, now)).toBe(false);
    expect(isPrimeEligible(hit({ proof: 2 }), cfg, now)).toBe(true);
    expect(isPrimeEligible(hit({ proof: 5, disputed: true }), cfg, now)).toBe(false);
    expect(isPrimeEligible(hit({ proof: 5, verified: false }), cfg, now)).toBe(false);
  });
  it('models: fresh ok; stale ok only when recent; unverified never', () => {
    expect(isPrimeEligible(hit({ kind: 'model' }), cfg, now)).toBe(true);
    expect(isPrimeEligible(hit({ kind: 'model', stale: true, asOf: '2026-10-05T00:00:00Z' }), cfg, now)).toBe(true);
    expect(isPrimeEligible(hit({ kind: 'model', stale: true, asOf: '2026-08-01T00:00:00Z' }), cfg, now)).toBe(false);
    expect(isPrimeEligible(hit({ kind: 'model', verified: false }), cfg, now)).toBe(false);
  });
  it('raw facts are introspection-only', () => {
    expect(isPrimeEligible(hit({ kind: 'fact' }), cfg, now)).toBe(false);
  });
});

describe('loaded-context suppression', () => {
  const memoryMd = 'AWS profile feedback: Always use AWS_PROFILE=default; the shell has AWS_PROFILE=work set which breaks auth.';
  it('detects knowledge already present in always-loaded files', () => {
    expect(isAlreadyLoaded('Always use AWS_PROFILE=default because the shell has AWS_PROFILE=work set.', memoryMd)).toBe(true);
  });
  it('does not suppress genuinely new knowledge', () => {
    expect(isAlreadyLoaded('The Pooler relay listens on port 8443 behind mutual TLS at relay.example.com.', memoryMd)).toBe(false);
  });
  it('empty corpus never suppresses; coverage is 0..1', () => {
    expect(isAlreadyLoaded('anything at all here', '')).toBe(false);
    expect(coverage('relay port 8443', 'relay port 8443')).toBe(1);
    expect(keyTokens('The and for').size).toBe(0);
  });
});

describe('retrieval boosts', () => {
  it('boost is neutral at 0.5 and bounded by alpha', () => {
    expect(boost(0.2, 0.5)).toBe(1);
    expect(boost(0.2, 1)).toBeCloseTo(1.1, 6);
    expect(boost(0.2, 0)).toBeCloseTo(0.9, 6);
  });
  it('proof signal saturates; recency decays over a year', () => {
    expect(proofSignal(0)).toBe(0);
    expect(proofSignal(10)).toBeCloseTo(1, 6);
    expect(proofSignal(100)).toBe(1);
    const now = Date.parse('2026-10-12T00:00:00Z');
    expect(recencySignal('2026-10-12T00:00:00Z', now)).toBeCloseTo(1, 3);
    expect(recencySignal('2025-10-12T00:00:00Z', now)).toBeCloseTo(0, 2);
  });
});

import { labelKey, parseVerdict, summarize } from '../../src/knowledge/prime-labels.js';
describe('prime labels', () => {
  it('keys on prompt hash + sorted refs, never the prompt text', () => {
    const k = labelKey('how do I run docker', ['model:b', 'obs:a']);
    expect(k).toMatch(/^[0-9a-f]{24}$/);
    expect(labelKey('how do I run docker', ['obs:a', 'model:b'])).toBe(k);
    expect(labelKey('how do I run docker!', ['obs:a', 'model:b'])).not.toBe(k);
  });
  it('parses judge JSON strictly', () => {
    expect(parseVerdict('{"verdict":"helpful","reason":"on topic"}')).toEqual({ verdict: 'helpful', reason: 'on topic' });
    expect(parseVerdict('sure! {"verdict":"maybe"}')).toBeNull();
    expect(parseVerdict('no json')).toBeNull();
  });
  it('summarises precision over fixed labels and counts unlabelled fires', () => {
    const labels = { a: { verdict: 'helpful' as const, reason: '' }, b: { verdict: 'irrelevant' as const, reason: '' } };
    expect(summarize([{ key: 'a' }, { key: 'b' }, { key: 'c' }], labels)).toEqual({ labelled: 2, helpful: 1, neutral: 0, irrelevant: 1, unlabelled: 1 });
  });
});
