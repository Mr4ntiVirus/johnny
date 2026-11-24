import { describe, it, expect } from 'vitest';
import { isInCooldown, filterByCooldown } from '../../src/engine/cooldown.js';

const gate = { cooldownTurns: 6, subjectShiftThreshold: 0.78 };

function ctx(map: Record<string, number>, currentTurn: number) {
  return { surfacedMap: map, currentTurn };
}

describe('engine/cooldown.ts', () => {
  it('memories never surfaced are not in cooldown', () => {
    expect(isInCooldown('m1', 0.5, ctx({}, 10), gate)).toBe(false);
  });

  it('held back when surfaced recently and similarity below shift threshold', () => {
    expect(isInCooldown('m1', 0.5, ctx({ m1: 8 }, 10), gate)).toBe(true);
  });

  it('break (a): time elapsed releases cooldown', () => {
    // surfaced at turn 2, current turn 8 → delta = 6 ≥ cooldownTurns
    expect(isInCooldown('m1', 0.5, ctx({ m1: 2 }, 8), gate)).toBe(false);
  });

  it('break (a) boundary: exactly cooldownTurns elapsed releases', () => {
    expect(isInCooldown('m1', 0.5, ctx({ m1: 4 }, 10), gate)).toBe(false);
  });

  it('break (a) boundary: one turn shy still held', () => {
    expect(isInCooldown('m1', 0.5, ctx({ m1: 5 }, 10), gate)).toBe(true);
  });

  it('break (b): bullseye similarity overrides time-based cooldown', () => {
    // Recent surface but similarity above shift threshold
    expect(isInCooldown('m1', 0.85, ctx({ m1: 9 }, 10), gate)).toBe(false);
  });

  it('break (b) boundary: exactly subjectShiftThreshold releases', () => {
    expect(isInCooldown('m1', 0.78, ctx({ m1: 9 }, 10), gate)).toBe(false);
  });

  it('break (b) boundary: one tick below threshold still held', () => {
    expect(isInCooldown('m1', 0.77, ctx({ m1: 9 }, 10), gate)).toBe(true);
  });

  it('null similarity cannot trigger break (b)', () => {
    // Without an embedding, only time-based break can release.
    expect(isInCooldown('m1', null, ctx({ m1: 9 }, 10), gate)).toBe(true);
    expect(isInCooldown('m1', null, ctx({ m1: 2 }, 10), gate)).toBe(false);
  });

  it('filterByCooldown drops in-cooldown candidates and preserves order', () => {
    const candidates = [
      { memory: { id: 'a' }, score: 0.6 },  // surfaced recent, not bullseye → held
      { memory: { id: 'b' }, score: 0.6 },  // never surfaced → kept
      { memory: { id: 'c' }, score: 0.85 }, // surfaced recent, bullseye → kept (break b)
      { memory: { id: 'd' }, score: 0.6 },  // surfaced long ago → kept (break a)
    ];
    const surfacedMap = { a: 9, c: 9, d: 2 };
    const out = filterByCooldown(candidates, ctx(surfacedMap, 10), gate);
    expect(out.map(c => c.memory.id)).toEqual(['b', 'c', 'd']);
  });

  it('filterByCooldown returns empty list given empty input', () => {
    expect(filterByCooldown([], ctx({}, 10), gate)).toEqual([]);
  });
});
