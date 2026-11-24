import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import { useLocalSqlite } from '../../helpers/sqlite.js';
import { recordPrimeEvent, getPrimeStats, getLastPrimeEvent } from '../../../src/store/db/prime-events.js';
import { execute } from '../../../src/store/db-client.js';

function suite(label: string, useDb: () => void) {
  describe(`${label} prime_events`, () => {
    useDb();

    it('counts primed / none / failed per window', async () => {
      await recordPrimeEvent({ sessionId: 's1', trigger: 'first-prompt', outcome: 'primed', refs: ['model:a', 'obs:b'], topScore: 0.71 });
      await recordPrimeEvent({ sessionId: 's1', trigger: 'continuation', outcome: 'none' });
      await recordPrimeEvent({ sessionId: 's1', trigger: 'continuation', outcome: 'none' });
      await recordPrimeEvent({ sessionId: 's2', trigger: 'topic-switch', outcome: 'failed', error: 'Ollama /api/embeddings → 500' });
      const st = await getPrimeStats(new Date(Date.now() - 60_000).toISOString());
      expect(st).toEqual({ evaluated: 4, primed: 1, failed: 1 });
    });

    it('excludes events older than the window and reports the latest event', async () => {
      await execute(
        `INSERT INTO prime_events (id, created_at, trigger, outcome) VALUES (?, ?, ?, ?)`,
        ['old', new Date(Date.now() - 3 * 86_400_000).toISOString(), 'tool', 'primed']);
      await recordPrimeEvent({ trigger: 'first-prompt', outcome: 'failed', error: 'boom' });
      const day = await getPrimeStats(new Date(Date.now() - 86_400_000).toISOString());
      expect(day).toEqual({ evaluated: 1, primed: 0, failed: 1 });
      const week = await getPrimeStats(new Date(Date.now() - 7 * 86_400_000).toISOString());
      expect(week.evaluated).toBe(2);
      expect((await getLastPrimeEvent())?.error).toBe('boom');
    });

    it('truncates long errors to 300 chars', async () => {
      await recordPrimeEvent({ trigger: 'tool', outcome: 'failed', error: 'x'.repeat(5000) });
      expect((await getLastPrimeEvent())?.error).toHaveLength(300);
    });
  });
}

suite('[postgres]', useTestDb);
suite('[sqlite]', useLocalSqlite);
