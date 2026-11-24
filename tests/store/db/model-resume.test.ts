import { describe, it, expect } from 'vitest';
import { useLocalSqlite } from '../../helpers/sqlite.js';
import * as modelsDb from '../../../src/store/db/mental-models.js';
import { execute, query } from '../../../src/store/db-client.js';

describe('resumeCooledModels (paused models must not need a human)', () => {
  useLocalSqlite();
  const mk = (slug: string) => modelsDb.createModel({ slug, name: slug, sourceQuery: 'q', scope: 'global', content: 'x' });

  it('resumes only models paused longer than the cooldown, leaving one strike before re-pausing', async () => {
    await mk('old'); await mk('recent');
    const old = new Date(Date.now() - 7 * 3600_000).toISOString();
    await execute(`UPDATE mental_models SET paused = 1, fail_count = 3, updated_at = ? WHERE slug = 'old'`, [old]);
    await execute(`UPDATE mental_models SET paused = 1, fail_count = 3, updated_at = ? WHERE slug = 'recent'`, [new Date().toISOString()]);

    expect(await modelsDb.resumeCooledModels()).toEqual(['old']);
    const rows = await query<{ slug: string; paused: number; fail_count: number; force_stale: number }>(
      `SELECT slug, paused, fail_count, force_stale FROM mental_models ORDER BY slug`);
    const by = Object.fromEntries(rows.map(r => [r.slug, r]));
    expect(by.old).toMatchObject({ paused: 0, fail_count: 2, force_stale: 1 });
    expect(by.recent.paused).toBe(1);

    // one more failure re-pauses immediately (no endless retry loop)
    await modelsDb.markModelFailure('old', 'unsupported claims after repair');
    const again = await query<{ paused: number }>(`SELECT paused FROM mental_models WHERE slug = 'old'`);
    expect(again[0].paused).toBe(1);
  });
});
