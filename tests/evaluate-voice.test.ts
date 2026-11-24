import { describe, it, expect } from 'vitest';
import { detectPraise } from '../src/cli/evaluate.js';

describe('detectPraise', () => {
  it('detects direct thanks', () => {
    expect(detectPraise('thanks!')).toBe(true);
    expect(detectPraise('thank you so much')).toBe(true);
  });

  it('detects positive adjectives', () => {
    expect(detectPraise('that was great')).toBe(true);
    expect(detectPraise('nice work')).toBe(true);
    expect(detectPraise('perfect')).toBe(true);
    expect(detectPraise('brilliant')).toBe(true);
    expect(detectPraise('awesome')).toBe(true);
  });

  it('detects praise mid-sentence', () => {
    expect(detectPraise('ok that looks good, now can you also...')).toBe(true);
    expect(detectPraise('solid. now let\'s do the next thing')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectPraise('GREAT job')).toBe(true);
    expect(detectPraise('THANKS')).toBe(true);
    expect(detectPraise('Nice')).toBe(true);
  });

  it('returns false for neutral prompts', () => {
    expect(detectPraise('fix the auth bug in token.ts')).toBe(false);
    expect(detectPraise('what is the difference between these two approaches')).toBe(false);
    expect(detectPraise('run the tests')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(detectPraise('')).toBe(false);
  });
});
