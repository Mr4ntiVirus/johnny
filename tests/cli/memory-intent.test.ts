import { describe, it, expect } from 'vitest';
import { detectMemoryIntent, isCapturableRemainder } from '../../src/cli/evaluate.js';

describe('detectMemoryIntent — captures facts, not fragments (2026-10-13)', () => {
  it('does not capture the deictic remainder of "make a note of that somewhere in your memory"', () => {
    // real prompt that produced the 8-token junk memory "of that somewhere in your memory"
    const r = detectMemoryIntent("I do have gold image experience. You can make a note of that somewhere in your memory.");
    expect(r.shouldCapture).toBe(false);
  });

  it('captures a self-contained fact after "remember that"', () => {
    const r = detectMemoryIntent('Remember that the fetch server root volume was grown to 40GB on 2026-08-20 after the disk filled.');
    expect(r.shouldCapture).toBe(true);
    expect(r.summary).toMatch(/fetch server root volume/);
  });

  it('too-short remainder is not captured', () => {
    expect(detectMemoryIntent('note that it works').shouldCapture).toBe(false);
  });

  it('trigger must be a whole phrase ("catalog that" does not contain "log that")', () => {
    expect(detectMemoryIntent('please catalog that inventory of servers and the old backup drives we found').shouldCapture).toBe(false);
  });

  it('isCapturableRemainder rejects deictic starts and accepts content', () => {
    expect(isCapturableRemainder('of that somewhere in your memory and other words here')).toBe(false);
    expect(isCapturableRemainder('Alice prefers terse replies with no trailing summaries ever')).toBe(true);
  });
});
