import { describe, it, expect } from 'vitest';
import {
  validateOps, extractNumbers, isSafeNearDuplicate, hasNegation, entitySignature,
  type ValidationContext,
} from '../../src/knowledge/validate.js';

const ctx = (): ValidationContext => ({
  facts: new Map([
    ['F1', { text: 'The Johnny database relay listens on port 8443.', quote: 'relay on 8443', dateText: '2026-06-13' }],
    ['F2', { text: 'The relay uses mutual TLS client certificates.', quote: 'mTLS relay', dateText: '2026-06-14' }],
  ]),
  observations: new Map([['O1', { text: 'The relay is reachable at relay.example.com on port 8443.' }]]),
});

describe('extractNumbers', () => {
  it('normalises separators and leading zeros', () => {
    const n = extractNumbers('port 8,443 on 2026-06-13 and v1.2.3');
    for (const x of ['8443', '2026', '6', '13', '1', '2', '3']) expect(n.has(x)).toBe(true);
  });
});

describe('validateOps', () => {
  it('accepts well-formed create / update / supersede / retire', () => {
    const { ops, rejected } = validateOps([
      { op: 'create', text: 'The Johnny database relay listens on port 8443 and requires mutual TLS.', facts: ['F1', 'F2'], facet: 'relay', subject: 'relay', reason: 'no existing observation covers the relay' },
      { op: 'update', obs: 'O1', text: 'The relay is reachable at relay.example.com on port 8443 (mutual TLS).', facts: ['F2'], reason: 'adds the mTLS detail' },
    ], ctx());
    expect(rejected).toEqual([]);
    expect(ops.map(o => o.op)).toEqual(['create', 'update']);
    expect(ops[0].factRefs).toEqual(['F1', 'F2']);

    const r = validateOps([{ op: 'retire', obs: 'O1', reason: 'relay was decommissioned' }], ctx());
    expect(r.ops).toHaveLength(1);
    const s = validateOps([{ op: 'supersede', obs: 'O1', text: 'The relay now listens on port 8443 behind mutual TLS.', facts: ['F1'], reason: 'replaced' }], ctx());
    expect(s.ops[0].obsRef).toBe('O1');
  });

  it('rejects invented numbers (never calculate or derive)', () => {
    const { ops, rejected } = validateOps([
      { op: 'create', text: 'The relay handles roughly 9000 requests and listens on port 8443 today.', facts: ['F1'], reason: 'summarises relay load' },
    ], ctx());
    expect(ops).toHaveLength(0);
    expect(rejected[0].reason).toBe('invented-number:9000');
  });

  it('allows numbers from the cited fact dates and from the observation being updated', () => {
    const ok = validateOps([
      { op: 'update', obs: 'O1', text: 'As of 2026-06-14 the relay is reachable at relay.example.com on port 8443.', facts: ['F2'], reason: 'adds a date for the change' },
    ], ctx());
    expect(ok.rejected).toEqual([]);
  });

  it('rejects unknown ids, missing reason, no facts, short/long text, uuid and json leakage', () => {
    const cases: Array<[unknown, string]> = [
      [{ op: 'create', text: 'x'.repeat(30), facts: ['F9'], reason: 'because reasons' }, 'unknown-fact'],
      [{ op: 'update', obs: 'O9', text: 'x'.repeat(30), facts: ['F1'], reason: 'because reasons' }, 'unknown-observation'],
      [{ op: 'create', text: 'x'.repeat(30), facts: ['F1'] }, 'missing-reason'],
      [{ op: 'create', text: 'x'.repeat(30), facts: [], reason: 'because reasons' }, 'no-facts-cited'],
      [{ op: 'create', text: 'short', facts: ['F1'], reason: 'because reasons' }, 'text-too-short'],
      [{ op: 'create', text: 'y'.repeat(800), facts: ['F1'], reason: 'because reasons' }, 'text-too-long'],
      [{ op: 'create', text: 'relay id 123e4567-e89b-12d3-a456-426614174000 is fine', facts: ['F1'], reason: 'because reasons' }, 'uuid-in-text'],
      [{ op: 'create', text: '{"a":"b"} relay config text here', facts: ['F1'], reason: 'because reasons' }, 'json-in-text'],
      [{ op: 'frobnicate', text: 'x'.repeat(30), facts: ['F1'], reason: 'because reasons' }, 'bad-op'],
      ['nope', 'not-object'],
    ];
    for (const [raw, why] of cases) {
      const { ops, rejected } = validateOps([raw], ctx());
      expect(ops).toHaveLength(0);
      expect(rejected[0].reason).toBe(why);
    }
  });

  it('allows only one op per observation in a batch', () => {
    const { ops, rejected } = validateOps([
      { op: 'update', obs: 'O1', text: 'The relay is reachable at relay.example.com on port 8443 (mTLS).', facts: ['F2'], reason: 'first change' },
      { op: 'retire', obs: 'O1', reason: 'second change on same observation' },
    ], ctx());
    expect(ops).toHaveLength(1);
    expect(rejected[0].reason).toBe('duplicate-op-for-observation');
  });

  it('tolerates a non-array input', () => {
    expect(validateOps(null, ctx())).toEqual({ ops: [], rejected: [] });
  });
});

describe('near-duplicate guard', () => {
  it('merges true restatements', () => {
    expect(isSafeNearDuplicate(
      'The Johnny relay listens on port 8443 behind mutual TLS.',
      'The Johnny relay listens on port 8443 behind mutual TLS.')).toBe(true);
  });
  it('keeps apart differing numbers, negations or entities', () => {
    expect(isSafeNearDuplicate('The relay listens on port 8443.', 'The relay listens on port 5432.')).toBe(false);
    expect(isSafeNearDuplicate('The relay requires mutual TLS.', 'The relay does not require mutual TLS.')).toBe(false);
    expect(isSafeNearDuplicate('Stream uses Jellyfin on the media server.', 'Stream uses Navidrome on the media server.')).toBe(false);
  });
  it('helpers', () => {
    expect(hasNegation('it is disabled')).toBe(true);
    expect(hasNegation('it is enabled')).toBe(false);
    expect(entitySignature('Alice runs Jellyfin at media.example.com').has('jellyfin')).toBe(true);
  });
});
