import { describe, it, expect } from 'vitest';
import { isGenericSummary, parseResummary } from '../../src/maintenance/resummarize.js';

describe('isGenericSummary', () => {
  it('flags the stock vague summaries seen in the live store', () => {
    expect(isGenericSummary('Implemented UI improvements and resolved backend issues for Johnny system.')).toBe(true);
    expect(isGenericSummary('Implemented bug fixes and reviewed code for correctness.')).toBe(true);
    expect(isGenericSummary('worked on: a, b, c')).toBe(true);
    expect(isGenericSummary(null)).toBe(true);
  });
  it('keeps specific summaries', () => {
    expect(isGenericSummary('Fixed fetch server storage_manager.py wiping the downloads volume with an unconditional mkfs; now checks blkid first')).toBe(false);
  });
});

describe('parseResummary', () => {
  it('accepts a specific title and summary', () => {
    const r = parseResummary('{"title":"Fetch storage mkfs data-loss fix","summary":"Fixed storage_manager.py wiping reattached volumes with unconditional mkfs; now checks blkid first."}');
    expect(r?.title).toMatch(/mkfs/);
  });
  it('rejects the empty "no specific content" reply and malformed output', () => {
    expect(parseResummary('{"title":"","summary":""}')).toBeNull();
    expect(parseResummary('not json')).toBeNull();
  });
});
