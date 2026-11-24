import { describe, it, expect } from 'vitest';
import { cosine } from '../../src/engine/embedder.js';

describe('cosine similarity', () => {
  it('identical vectors → 1.0', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors → 0.0', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });

  it('opposite vectors → -1.0', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it('empty vectors → 0', () => {
    expect(cosine([], [])).toBe(0);
  });

  it('length mismatch → 0', () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });
});
