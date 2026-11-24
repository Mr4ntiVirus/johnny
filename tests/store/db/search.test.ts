import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as memoriesDb from '../../../src/store/db/memories.js';
import * as transcriptsDb from '../../../src/store/db/transcripts.js';
import * as searchDb from '../../../src/store/db/search.js';

async function seedMemWithTranscript(
  slug: string,
  title: string,
  transcript: string,
  opts: { rank?: number; contentType?: 'text' | 'skill' | 'tool' } = {},
): Promise<string> {
  const id = await memoriesDb.createMemory({
    snapshotName: slug,
    title,
    summary: title,
    contentType: opts.contentType ?? 'text',
    projectPath: '/tmp',
    tokenCount: 10,
    createdAtTurn: 1,
  });
  await transcriptsDb.createTranscript({ memoryId: id, transcript });
  if (opts.rank !== undefined) {
    await memoriesDb.updateMemoryRank(id, opts.rank, 1);
  }
  return id;
}

describe('db/search.ts', () => {
  useTestDb();

  it('fullTextSearch matches title', async () => {
    await seedMemWithTranscript('a', 'Authentication Bug', 'lorem ipsum');
    await seedMemWithTranscript('b', 'Layout Refactor', 'dolor sit amet');

    const hits = await searchDb.fullTextSearch({ query: 'authentication' });
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe('Authentication Bug');
  });

  it('fullTextSearch matches snapshot slug', async () => {
    await seedMemWithTranscript('widget-fix', 'title', 'body');
    const hits = await searchDb.fullTextSearch({ query: 'widget' });
    expect(hits.length).toBe(1);
    expect(hits[0].snapshotName).toBe('widget-fix');
  });

  it('fullTextSearch matches transcript body', async () => {
    await seedMemWithTranscript('a', 'A', 'unicorn appears in body');
    await seedMemWithTranscript('b', 'B', 'nothing special');

    const hits = await searchDb.fullTextSearch({ query: 'unicorn' });
    expect(hits.length).toBe(1);
    expect(hits[0].snapshotName).toBe('a');
  });

  it('fullTextSearch is case-insensitive', async () => {
    await seedMemWithTranscript('a', 'HELLO World', 'body');
    const hits = await searchDb.fullTextSearch({ query: 'hello' });
    expect(hits.length).toBe(1);
  });

  it('fullTextSearch honors limit', async () => {
    for (let i = 0; i < 5; i++) {
      await seedMemWithTranscript(`s${i}`, 'widget', 'body');
    }
    const hits = await searchDb.fullTextSearch({ query: 'widget', limit: 2 });
    expect(hits.length).toBe(2);
  });

  it('fullTextSearch returns empty array when no match', async () => {
    await seedMemWithTranscript('a', 'A', 'body');
    expect(await searchDb.fullTextSearch({ query: 'nonexistent' })).toEqual([]);
  });

  it('fullTextSearch orders by rank desc', async () => {
    await seedMemWithTranscript('low', 'widget', 'body', { rank: 0.1 });
    await seedMemWithTranscript('high', 'widget', 'body', { rank: 0.9 });
    await seedMemWithTranscript('mid', 'widget', 'body', { rank: 0.5 });

    const hits = await searchDb.fullTextSearch({ query: 'widget' });
    expect(hits.map(h => h.snapshotName)).toEqual(['high', 'mid', 'low']);
  });

  it('fullTextSearch requires a transcript row (JOIN behavior)', async () => {
    // Memory without transcript — won't appear in search results.
    await memoriesDb.createMemory({
      snapshotName: 'ghost',
      title: 'widget ghost',
      contentType: 'text',
      projectPath: '/tmp',
      tokenCount: 1,
      createdAtTurn: 1,
    });
    const hits = await searchDb.fullTextSearch({ query: 'widget' });
    expect(hits.length).toBe(0);
  });

  it('getRecentMemories returns most recent first', async () => {
    await seedMemWithTranscript('old', 'A', 'body');
    await new Promise(r => setTimeout(r, 5));
    await seedMemWithTranscript('new', 'B', 'body');

    const recent = await searchDb.getRecentMemories(10);
    expect(recent[0].snapshotName).toBe('new');
    expect(recent[1].snapshotName).toBe('old');
  });

  it('getRecentMemories honors limit', async () => {
    for (let i = 0; i < 5; i++) {
      await seedMemWithTranscript(`s${i}`, 'T', 'body');
    }
    const recent = await searchDb.getRecentMemories(2);
    expect(recent.length).toBe(2);
  });

  it('rebuildFTS reports success with no errors', async () => {
    await seedMemWithTranscript('a', 'A', 'body');
    const result = await searchDb.rebuildFTS();
    expect(result.errors).toBe(0);
  });
});
