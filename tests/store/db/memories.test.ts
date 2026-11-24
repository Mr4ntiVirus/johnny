import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as memoriesDb from '../../../src/store/db/memories.js';

function mk(overrides: Partial<memoriesDb.MemoryInput> = {}): memoriesDb.MemoryInput {
  return {
    snapshotName: 'slug-default',
    title: 'Default Title',
    summary: 'default summary',
    contentType: 'text',
    projectPath: '/tmp/proj',
    tokenCount: 100,
    createdAtTurn: 1,
    ...overrides,
  };
}

describe('db/memories.ts', () => {
  useTestDb();

  it('createMemory returns an id and persists row', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'alpha' }));
    expect(id).toBeTruthy();
    const row = await memoriesDb.getMemory(id);
    expect(row?.snapshot_name).toBe('alpha');
    expect(row?.title).toBe('Default Title');
    expect(row?.summary).toBe('default summary');
    expect(row?.content_type).toBe('text');
    expect(row?.token_count).toBe(100);
    expect(row?.rank).toBeCloseTo(0.15);
    expect(row?.retrieval_count).toBe(0);
  });

  it('createMemory honors explicit id', async () => {
    const id = await memoriesDb.createMemory(mk({ id: 'fixed-id', snapshotName: 'beta' }));
    expect(id).toBe('fixed-id');
  });

  it('UNIQUE(snapshot_name) rejects duplicates', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'dup' }));
    await expect(memoriesDb.createMemory(mk({ snapshotName: 'dup' }))).rejects.toThrow();
  });

  it('getMemory returns null for missing id', async () => {
    expect(await memoriesDb.getMemory('nope')).toBeNull();
  });

  it('getMemoryBySnapshot finds by slug', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'findme' }));
    const row = await memoriesDb.getMemoryBySnapshot('findme');
    expect(row?.snapshot_name).toBe('findme');
  });

  it('memoryExists returns true/false', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'exists' }));
    expect(await memoriesDb.memoryExists('exists')).toBe(true);
    expect(await memoriesDb.memoryExists('missing')).toBe(false);
  });

  it('listMemories filters by contentType', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'a', contentType: 'text' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'b', contentType: 'skill' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'c', contentType: 'skill' }));

    const skills = await memoriesDb.listMemories({ contentType: 'skill' });
    expect(skills.map(r => r.snapshot_name).sort()).toEqual(['b', 'c']);
  });

  it('listMemories filters by projectPath', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'p1', projectPath: '/a' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'p2', projectPath: '/b' }));
    const rows = await memoriesDb.listMemories({ projectPath: '/a' });
    expect(rows.length).toBe(1);
    expect(rows[0].snapshot_name).toBe('p1');
  });

  it('listMemories honors limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await memoriesDb.createMemory(mk({ snapshotName: `s${i}` }));
    }
    const page1 = await memoriesDb.listMemories({ limit: 2, offset: 0 });
    const page2 = await memoriesDb.listMemories({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    const ids = new Set([...page1, ...page2].map(r => r.id));
    expect(ids.size).toBe(4);
  });

  it('listMemories orderBy rank sorts desc', async () => {
    const id1 = await memoriesDb.createMemory(mk({ snapshotName: 'low' }));
    const id2 = await memoriesDb.createMemory(mk({ snapshotName: 'high' }));
    await memoriesDb.updateMemoryRank(id2, 0.9, 5);
    await memoriesDb.updateMemoryRank(id1, 0.1, 5);

    const rows = await memoriesDb.listMemories({ orderBy: 'rank' });
    expect(rows[0].snapshot_name).toBe('high');
    expect(rows[1].snapshot_name).toBe('low');
  });

  it('listMemories orderBy retrieval_count sorts desc', async () => {
    const id1 = await memoriesDb.createMemory(mk({ snapshotName: 'cold' }));
    const id2 = await memoriesDb.createMemory(mk({ snapshotName: 'hot' }));
    await memoriesDb.recordRetrieval(id2, 1);
    await memoriesDb.recordRetrieval(id2, 2);
    await memoriesDb.recordRetrieval(id1, 3);

    const rows = await memoriesDb.listMemories({ orderBy: 'retrieval_count' });
    expect(rows[0].snapshot_name).toBe('hot');
  });

  it('recordRetrieval increments count and stamps turn + timestamp', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'ret' }));
    await memoriesDb.recordRetrieval(id, 42);
    const row = await memoriesDb.getMemory(id);
    expect(row?.retrieval_count).toBe(1);
    expect(row?.last_retrieved_turn).toBe(42);
    expect(row?.last_retrieved_at).toBeTruthy();

    await memoriesDb.recordRetrieval(id, 43);
    const row2 = await memoriesDb.getMemory(id);
    expect(row2?.retrieval_count).toBe(2);
    expect(row2?.last_retrieved_turn).toBe(43);
  });

  it('updateMemoryRank persists new rank', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'rk' }));
    await memoriesDb.updateMemoryRank(id, 0.42, 10);
    const row = await memoriesDb.getMemory(id);
    expect(row?.rank).toBeCloseTo(0.42);
    expect(row?.last_retrieved_turn).toBe(10);
  });

  it('getMemoryCount reflects insertions', async () => {
    expect(await memoriesDb.getMemoryCount()).toBe(0);
    await memoriesDb.createMemory(mk({ snapshotName: 'a' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'b' }));
    expect(await memoriesDb.getMemoryCount()).toBe(2);
  });

  it('getTopMemoriesByRank returns limit, sorted desc', async () => {
    const ids = await Promise.all(['a', 'b', 'c'].map(s => memoriesDb.createMemory(mk({ snapshotName: s }))));
    await memoriesDb.updateMemoryRank(ids[0], 0.1, 1);
    await memoriesDb.updateMemoryRank(ids[1], 0.9, 1);
    await memoriesDb.updateMemoryRank(ids[2], 0.5, 1);

    const top2 = await memoriesDb.getTopMemoriesByRank(2);
    expect(top2.length).toBe(2);
    expect(top2[0].rank).toBeCloseTo(0.9);
    expect(top2[1].rank).toBeCloseTo(0.5);
  });

  it('deleteMemory removes the row', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'del' }));
    await memoriesDb.deleteMemory(id);
    expect(await memoriesDb.getMemory(id)).toBeNull();
  });

  // Schema quarantine gate
  it('listMemories excludes schemas by default', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'normal', contentType: 'text' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'gist', contentType: 'schema' }));
    const rows = await memoriesDb.listMemories();
    const names = rows.map(r => r.snapshot_name);
    expect(names).toContain('normal');
    expect(names).not.toContain('gist');
  });

  it('listMemories includes schemas when includeSchemas: true', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'real', contentType: 'text' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'schema-node', contentType: 'schema' }));
    const rows = await memoriesDb.listMemories({ includeSchemas: true });
    const names = rows.map(r => r.snapshot_name);
    expect(names).toContain('real');
    expect(names).toContain('schema-node');
  });

  it('listSchemas returns only schema-typed rows', async () => {
    await memoriesDb.createMemory(mk({ snapshotName: 'text-mem', contentType: 'text' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'schema-a', contentType: 'schema' }));
    await memoriesDb.createMemory(mk({ snapshotName: 'schema-b', contentType: 'schema' }));
    const rows = await memoriesDb.listSchemas();
    const names = rows.map(r => r.snapshot_name).sort();
    expect(names).toEqual(['schema-a', 'schema-b']);
  });

  it('approveSchema promotes schema to text content_type', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'promote-me', contentType: 'schema' }));
    await memoriesDb.approveSchema(id);
    const row = await memoriesDb.getMemory(id);
    expect(row?.content_type).toBe('text');
    // Now appears in normal listMemories
    const all = await memoriesDb.listMemories();
    expect(all.some(r => r.id === id)).toBe(true);
  });

  it('rejectSchema deletes the row', async () => {
    const id = await memoriesDb.createMemory(mk({ snapshotName: 'reject-me', contentType: 'schema' }));
    await memoriesDb.rejectSchema(id);
    expect(await memoriesDb.getMemory(id)).toBeNull();
  });
});
