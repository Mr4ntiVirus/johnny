import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as stateDb from '../../../src/store/db/state.js';

describe('db/state.ts', () => {
  useTestDb();

  it('migration seeds initial state keys', async () => {
    expect(await stateDb.getTurnCounter()).toBe(0);
    expect(await stateDb.getRankUpdatedTurn()).toBe(0);
    expect(await stateDb.getSchemaVersion()).toBe(2);
  });

  it('getState returns null for missing key', async () => {
    expect(await stateDb.getState('nope')).toBeNull();
  });

  it('setState inserts a new key', async () => {
    await stateDb.setState('custom', 'hello');
    expect(await stateDb.getState('custom')).toBe('hello');
  });

  it('setState upserts existing keys (ON CONFLICT DO UPDATE)', async () => {
    await stateDb.setState('custom', 'one');
    await stateDb.setState('custom', 'two');
    expect(await stateDb.getState('custom')).toBe('two');
  });

  it('incrementTurn returns next value and persists', async () => {
    expect(await stateDb.incrementTurn()).toBe(1);
    expect(await stateDb.incrementTurn()).toBe(2);
    expect(await stateDb.incrementTurn()).toBe(3);
    expect(await stateDb.getTurnCounter()).toBe(3);
  });

  it('setRankUpdatedTurn persists and reads back', async () => {
    await stateDb.setRankUpdatedTurn(42);
    expect(await stateDb.getRankUpdatedTurn()).toBe(42);
  });

  it('getTurnCounter handles uninitialized gracefully', async () => {
    // Simulate missing key by overwriting with empty; getState returns '' which parseInt → NaN → fallback
    await stateDb.setState('turn_counter', '');
    // Empty string → falsy → returns 0
    expect(await stateDb.getTurnCounter()).toBe(0);
  });

  it('initState is idempotent (does not reset existing counter)', async () => {
    await stateDb.incrementTurn();
    await stateDb.incrementTurn();
    await stateDb.initState();
    expect(await stateDb.getTurnCounter()).toBe(2);
  });
});
