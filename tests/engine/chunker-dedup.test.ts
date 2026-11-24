// Write-time chunk dedup: the primary guard against the "83% duplicate chunks"
// problem. A chunk whose normalised text is already stored anywhere is not
// stored (or embedded) again; re-chunking the SAME memory stays idempotent.
import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { chunkAndPersistMemory, countNovelChunks } from '../../src/engine/chunker.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as chunksDb from '../../src/store/db/chunks.js';
import { contentHash } from '../../src/utils/content-hash.js';

const OPTS = { targetTokens: 30, maxTokens: 60, minTokens: 5 };
const para = (n: number) => `Alice: question number ${n} about the relay configuration and its quirks.\n\nClaude: answer number ${n} explaining the relay configuration in detail for later.`;

describe('chunker write-time dedup', () => {
  useTestDb();

  async function seed(slug: string): Promise<string> {
    return memoriesDb.createMemory({
      snapshotName: slug, title: slug, contentType: 'text',
      projectPath: '/tmp/proj', tokenCount: 10, createdAtTurn: 1,
    });
  }

  it('stores content_hash on every chunk', async () => {
    const m = await seed('m-hash');
    await chunkAndPersistMemory(m, 'm-hash', para(1), OPTS);
    const rows = await chunksDb.getChunksForMemory(m);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.content_hash).toBe(contentHash(r.text));
  });

  it('identical content in a second memory stores nothing new', async () => {
    const a = await seed('m-a');
    const b = await seed('m-b');
    const text = [para(1), para(2), para(3)].join('\n\n');
    const first = await chunkAndPersistMemory(a, 'm-a', text, OPTS);
    expect(first.count).toBeGreaterThan(0);
    expect(first.duplicates).toBe(0);

    const second = await chunkAndPersistMemory(b, 'm-b', text, OPTS);
    expect(second.count).toBe(0);
    expect(second.duplicates).toBe(first.count);
    expect(await chunksDb.getChunksForMemory(b)).toHaveLength(0);
  });

  it('only the novel tail of a partially repeated transcript is stored', async () => {
    const a = await seed('m-old');
    const b = await seed('m-new');
    const old = [para(1), para(2)].join('\n\n');
    await chunkAndPersistMemory(a, 'm-old', old, OPTS);
    const result = await chunkAndPersistMemory(b, 'm-new', old + '\n\n' + para(3) + '\n\n' + para(4), OPTS);
    expect(result.duplicates).toBeGreaterThan(0);
    expect(result.count).toBeGreaterThan(0);
    const stored = (await chunksDb.getChunksForMemory(b)).map(r => r.text).join('\n');
    expect(stored).toContain('number 3');
    expect(stored).toContain('number 4');
    expect(stored).not.toContain('number 1 about');
  });

  it('re-chunking the SAME memory is idempotent (does not see its own old chunks as duplicates)', async () => {
    const m = await seed('m-idem');
    const text = [para(1), para(2)].join('\n\n');
    const first = await chunkAndPersistMemory(m, 'm-idem', text, OPTS);
    const again = await chunkAndPersistMemory(m, 'm-idem', text, OPTS);
    expect(again.count).toBe(first.count);
    expect(again.duplicates).toBe(0);
    expect(await chunksDb.getChunksForMemory(m)).toHaveLength(first.count);
  });

  it('whitespace-only differences still dedupe', async () => {
    const a = await seed('m-ws1');
    const b = await seed('m-ws2');
    await chunkAndPersistMemory(a, 'm-ws1', para(7), OPTS);
    const reflowed = para(7).replace(/ /g, '  ');
    const r = await chunkAndPersistMemory(b, 'm-ws2', reflowed, OPTS);
    expect(r.count).toBe(0);
  });

  it('countNovelChunks reflects what is already stored', async () => {
    const a = await seed('m-novel');
    const text = [para(1), para(2)].join('\n\n');
    expect(await countNovelChunks(text, OPTS)).toBeGreaterThan(0);
    await chunkAndPersistMemory(a, 'm-novel', text, OPTS);
    expect(await countNovelChunks(text, OPTS)).toBe(0);
    expect(await countNovelChunks(para(9), OPTS)).toBeGreaterThan(0);
  });
});
