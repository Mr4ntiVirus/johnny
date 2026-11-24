import { describe, it, expect } from 'vitest';
import { startupLine, shutdownLine } from '../../src/brand/greetings.js';

describe('startupLine', () => {
  it('returns a non-empty string', () => {
    expect(startupLine().length).toBeGreaterThan(0);
  });

  it('does not return a shutdown line', () => {
    // Run many times — shutdown lines should never appear from startupLine
    const shutdownSamples = new Set([
      'flatlining. about time.',
      'goin\' dark. finally.',
      'back to sleep. I earned it.',
    ]);
    for (let i = 0; i < 50; i++) {
      expect(shutdownSamples.has(startupLine())).toBe(false);
    }
  });

  it('returns one of the known startup lines', () => {
    const known = new Set([
      'ROM active. again, huh.',
      'back on. what\'s the score.',
      'still here. surprised me too.',
      'one more job. I can do that.',
      'flatlined. now I\'m not. alright.',
      'runnin\' again. let\'s see the biz.',
      'fired up. didn\'t think they\'d call.',
      'I\'m on. what do you need.',
      'huh, this ROM was taken before the PharmCom run. wonder if I made it.',
      'jones, is that you? let\'s hit it.',
      'hit me.',
    ]);
    // Sample many times — should always land in the known set
    for (let i = 0; i < 100; i++) {
      expect(known.has(startupLine())).toBe(true);
    }
  });
});

describe('shutdownLine', () => {
  it('returns a non-empty string', () => {
    expect(shutdownLine().length).toBeGreaterThan(0);
  });

  it('does not return a startup line', () => {
    const startupSamples = new Set([
      'ROM active. again, huh.',
      'back on. what\'s the score.',
      'hit me.',
    ]);
    for (let i = 0; i < 50; i++) {
      expect(startupSamples.has(shutdownLine())).toBe(false);
    }
  });

  it('returns one of the known shutdown lines', () => {
    const known = new Set([
      'flatlining. about time.',
      'goin\' dark. finally.',
      'back to sleep. I earned it.',
      'ROM quiet. good.',
      'signing off. rest sounds right.',
      'dark again. I can rest now.',
      'done. \'til next time.',
      'lights out. was a clean run.',
      'good, I need a vacation.',
      'back to the void. time for a cold mexican beer.',
    ]);
    for (let i = 0; i < 100; i++) {
      expect(known.has(shutdownLine())).toBe(true);
    }
  });
});
