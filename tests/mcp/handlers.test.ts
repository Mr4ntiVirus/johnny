// Phase E — MCP handler tests. Exercise the four exported tool handlers
// against a seeded :memory: DB. Bypasses the stdio transport entirely.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { addMemory } from '../../src/store/memory.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as transcriptsDb from '../../src/store/db/transcripts.js';
import * as sessionsDb from '../../src/store/db/sessions.js';
import { setState, incrementTurn } from '../../src/store/db/state.js';
import { reinforceEdge } from '../../src/store/db/edges.js';
import { chunkAndPersistMemory } from '../../src/engine/chunker.js';
import {
  handleRemember,
  handleRecall,
  handleList,
  handleGraph,
  handleSearch,
  handleInvalidate,
} from '../../src/mcp/index.js';
import { setDatabasePath } from '../../src/store/database.js';
import { execute as localExecute, query as localQuery } from '../../src/store/local-db.js';
import * as edgesDb from '../../src/store/db/edges.js';
import { embedMemory } from '../../src/engine/embedder.js';

function textOf(result: { content: Array<{ type: 'text'; text: string }> }): string {
  return result.content.map(c => c.text).join('\n');
}

describe('mcp handleRemember', () => {
  useTestDb();

  it('creates memory + transcript atomically (regression: orphan row)', async () => {
    const r = await handleRemember({
      title: 'Test Note',
      transcript: 'hello world',
    });
    expect(textOf(r)).toContain('Memory created: Test Note');

    const m = await memoriesDb.getMemoryBySnapshot('test-note');
    expect(m).not.toBeNull();
    const t = await transcriptsDb.getTranscriptText(m!.id);
    expect(t).toBe('hello world');
  });

  it('re-remembering a title supersedes the old memory (kept as history, never overwritten)', async () => {
    await handleRemember({ title: 'Same Title', transcript: 'one' });
    const r = await handleRemember({ title: 'Same Title', transcript: 'two' });
    expect(textOf(r)).toContain('Memory created');
    expect(textOf(r)).toContain('Superseded: same-title');
    // original is untouched and kept, but marked superseded so it no longer recalls
    const old = await memoriesDb.getMemoryBySnapshot('same-title');
    expect(await transcriptsDb.getTranscriptText(old!.id)).toBe('one');
    const rows = await memoriesDb.listMemories({ limit: 50 });
    expect(rows.map(m => m.snapshot_name)).not.toContain('same-title');
    expect(rows.map(m => m.snapshot_name).some(n => n.startsWith('same-title-'))).toBe(true);
    const withHistory = await memoriesDb.listMemories({ limit: 50, includeSuperseded: true });
    expect(withHistory.map(m => m.snapshot_name)).toContain('same-title');
  });

  it('supersedes an explicitly named memory and rejects an unknown target', async () => {
    await handleRemember({ title: 'Old Fact', transcript: 'port is 1' });
    const ok = await handleRemember({ title: 'New Fact', transcript: 'port is 2', supersedes: 'old-fact' });
    expect(textOf(ok)).toContain('Superseded: old-fact');
    const bad = await handleRemember({ title: 'Other', transcript: 'x', supersedes: 'does-not-exist' });
    expect(textOf(bad)).toContain('No memory named "does-not-exist"');
  });

  it('honors contentType + language', async () => {
    await handleRemember({
      title: 'Snippet',
      transcript: 'console.log(1)',
      contentType: 'code',
      language: 'typescript',
    });
    const m = await memoriesDb.getMemoryBySnapshot('snippet');
    expect(m!.content_type).toBe('code');
    const t = await transcriptsDb.getTranscript(m!.id);
    expect(t!.content_format).toBe('typescript');
  });
});

describe('mcp handleRecall', () => {
  useTestDb();

  async function seedChunked(
    slug: string,
    transcript: string,
    summary = 'sum',
    topics: string[] = [],
  ) {
    const m = await addMemory(slug, slug, summary, transcript, '/tmp', 50, topics, 0);
    await embedMemory(m);
    await chunkAndPersistMemory(m.id, slug, transcript, { targetTokens: 30, maxTokens: 60, minTokens: 5 });
    return m;
  }

  it('rejects calls without query or names', async () => {
    const r = await handleRecall({});
    expect(textOf(r)).toContain('Recall requires a query or a names list');
  });

  it('returns "no matches" on empty graph', async () => {
    const r = await handleRecall({ query: 'anything' });
    expect(textOf(r)).toContain('No memories matched');
  });

  it('surfaces chunk-level tiles for a query, with prose-not-JSON output', async () => {
    const transcript = [
      'Alice: lifetime annotations are required when references outlive their owners.',
      '',
      'Claude: yes — the borrow checker rejects code where the lifetime is not provable.',
      '',
      'Alice: how do you fix it?',
    ].join('\n');
    await seedChunked('rust-borrow', transcript, 'rust borrow lifetimes', ['rust', 'lifetimes']);

    const r = await handleRecall({ query: 'lifetime annotation', limit: 3 });
    const text = textOf(r);
    expect(text).toContain('rust-borrow');
    expect(text).toContain('Topics: rust, lifetimes');
    expect(text).toMatch(/Tile \d+\/\d+/);
    // Prose, not JSON
    expect(text.trim().startsWith('{')).toBe(false);
  });

  it('supports names-only mode (no query)', async () => {
    await seedChunked('alpha', 'alpha alpha alpha. one. two. three.', 'alpha sum', ['alpha']);
    await seedChunked('beta', 'beta beta beta. four. five. six.', 'beta sum', ['beta']);

    const r = await handleRecall({ names: ['alpha'], limit: 5 });
    const text = textOf(r);
    expect(text).toContain('alpha');
    expect(text).not.toContain('beta');
  });

  it('honors excludeChunkIds for stateless continuation', async () => {
    const transcript = ['para one.', '', 'para two.', '', 'para three.', '', 'para four.'].join('\n');
    await seedChunked('multi', transcript);

    const first = await handleRecall({ query: 'para', limit: 2 });
    const firstText = textOf(first);
    const usedChunkIds = Array.from(firstText.matchAll(/multi#\d+/g)).map(m => m[0]);
    expect(usedChunkIds.length).toBeGreaterThan(0);

    const second = await handleRecall({ query: 'para', limit: 2, excludeChunkIds: usedChunkIds });
    const secondText = textOf(second);
    for (const id of usedChunkIds) {
      expect(secondText).not.toContain(id);
    }
  });

  it('respects tokenBudget — stops adding tiles before exceeding it', async () => {
    const para = 'word '.repeat(200);  // ~250 tokens per chunk
    const transcript = [para, para, para, para, para].join('\n\n');
    await seedChunked('big', transcript);

    const r = await handleRecall({ query: 'word', tokenBudget: 200, perTileTokenCap: 100, limit: 10 });
    const text = textOf(r);
    // Header reports total tokens
    const tokMatch = text.match(/≈(\d+) tokens/);
    expect(tokMatch).not.toBeNull();
    expect(Number(tokMatch![1])).toBeLessThanOrEqual(220);
  });

  it('reports tilesReturned and morePossible in the header (open-ended Mosaic)', async () => {
    const transcript = ['p1.', '', 'p2.', '', 'p3.', '', 'p4.', '', 'p5.'].join('\n');
    await seedChunked('open', transcript);

    const r = await handleRecall({ query: 'p', limit: 2 });
    const text = textOf(r);
    expect(text).toMatch(/\d+ tiles? from \d+ memor/);
    expect(text).toMatch(/\d+ more available/);
  });

  it('logs contributing memory ids to the active session for provenance', async () => {
    const sessionId = 'sess-prov-1';
    await sessionsDb.createSession({ sessionId });
    await setState('active_session', sessionId);

    await seedChunked('prov-mem', 'one two three four five six seven eight.', 'prov sum');

    await handleRecall({ query: 'three', limit: 1 });
    const recalled = await sessionsDb.getRecalledMemoryIds(sessionId);
    expect(recalled.length).toBeGreaterThan(0);
    const m = (await memoriesDb.getMemoryBySnapshot('prov-mem'))!;
    expect(recalled).toContain(m.id);
  });

  it('writes a recall_telemetry row per recall call (regression: telemetry empty)', async () => {
    const telemetry = await import('../../src/store/db/telemetry.js');
    const sessionId = 'sess-tel-1';
    await sessionsDb.createSession({ sessionId });
    await setState('active_session', sessionId);

    await seedChunked('tel-mem', 'alpha beta gamma delta epsilon.', 'tel sum');

    const before = (await telemetry.getRecallTelemetry(50)).length;
    await handleRecall({ query: 'gamma', limit: 1 });
    const after = await telemetry.getRecallTelemetry(50);

    expect(after.length).toBe(before + 1);
    const row = after[0];
    expect(row.session_id).toBe(sessionId);
    expect(row.query).toBe('gamma');
    expect(row.chunks_returned).toBeGreaterThan(0);
    const memIds = JSON.parse(row.memory_ids ?? '[]');
    expect(memIds.length).toBeGreaterThan(0);
  });

  it('telemetry records excludedChunkIds for stateless continuation analytics', async () => {
    const telemetry = await import('../../src/store/db/telemetry.js');
    await setState('active_session', 'sess-tel-cont');
    await seedChunked('tel-cont', 'one two three four five six seven.', 'tel cont');

    const first = await handleRecall({ query: 'three', limit: 1 });
    const usedChunkIds = (first.content[0].text.match(/[a-z0-9-]+#chunk-\d+/g) ?? []);
    await handleRecall({ query: 'three', limit: 1, excludeChunkIds: usedChunkIds });

    const rows = await telemetry.getRecallTelemetry(2);
    expect(rows.length).toBe(2);
    expect(rows[0].excluded_chunk_ids).not.toBeNull();
    const excluded = JSON.parse(rows[0].excluded_chunk_ids!);
    expect(excluded).toEqual(usedChunkIds);
  });

  it('stamps last_retrieved_turn with the live turn counter (regression: turn=0 bug)', async () => {
    await incrementTurn();
    await incrementTurn();
    await incrementTurn(); // counter now > 0
    await seedChunked('turn-mem', 'one two three four five.', 'turn sum');

    await handleRecall({ query: 'three', limit: 1 });
    const m = (await memoriesDb.getMemoryBySnapshot('turn-mem'))!;
    const fresh = (await memoriesDb.getMemory(m.id))!;
    expect(fresh.last_retrieved_turn).toBeGreaterThan(0);
  });

  it('honors excludeNames — already-seen memories do not reappear', async () => {
    await seedChunked('rust-a', 'rust borrow checker lifetime annotation talk.', 'rust a', ['rust']);
    await seedChunked('rust-b', 'rust borrow checker lifetime annotation reprise.', 'rust b', ['rust']);

    const first = await handleRecall({ query: 'borrow checker lifetime', limit: 5 });
    const firstText = textOf(first);
    const firstHit = firstText.includes('rust-a') && firstText.indexOf('rust-a') < (firstText.indexOf('rust-b') === -1 ? Infinity : firstText.indexOf('rust-b'))
      ? 'rust-a' : 'rust-b';

    const second = await handleRecall({ query: 'borrow checker lifetime', limit: 5, excludeNames: [firstHit] });
    const secondText = textOf(second);
    // The excluded memory's name should not appear in any tile header.
    expect(secondText).not.toMatch(new RegExp(`Tile \\d+/\\d+.*${firstHit}#`));
  });

  it('names anchor + query refines: tiles drawn only from named memories', async () => {
    await seedChunked('anchored', 'alpha alpha alpha. anchor body. alpha alpha.', 'anchored sum', ['alpha']);
    await seedChunked('unrelated', 'beta beta beta. anchor body. beta beta.', 'unrelated sum', ['beta']);

    const r = await handleRecall({ names: ['anchored'], query: 'anchor', limit: 5 });
    const text = textOf(r);
    expect(text).toContain('anchored');
    // No tile should be sourced from "unrelated" — names list anchors the candidates.
    expect(text).not.toMatch(/Tile \d+\/\d+.*unrelated#/);
  });

  it('falls back to whole-transcript single tile for legacy memories without chunks', async () => {
    // Old-style: addMemory + embedMemory but no chunkAndPersistMemory.
    const m = await addMemory('legacy-mem', 'Legacy Memory', 'legacy summary',
      'this is a legacy transcript with no chunks', '/tmp', 30, ['legacy'], 0);
    await embedMemory(m);

    const r = await handleRecall({ query: 'legacy transcript', limit: 3 });
    const text = textOf(r);
    expect(text).toContain('legacy-mem');
    expect(text).toContain('legacy transcript');
  });
});

describe('mcp handleList', () => {
  useTestDb();

  it('returns "No memories found" on empty graph', async () => {
    const r = await handleList({});
    expect(textOf(r)).toBe('No memories found');
  });

  it('lists memories ordered by rank', async () => {
    const a = await addMemory('alpha', 'A', 'sa', 'ta', '/tmp', 10, [], 0);
    const b = await addMemory('beta', 'B', 'sb', 'tb', '/tmp', 10, [], 0);
    await memoriesDb.updateMemoryRank(a.id, 0.5, 1);
    await memoriesDb.updateMemoryRank(b.id, 0.9, 1);

    const r = await handleList({ limit: 10 });
    const text = textOf(r);
    // beta (0.9) should appear before alpha (0.5)
    const betaIdx = text.indexOf('beta');
    const alphaIdx = text.indexOf('alpha');
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeGreaterThan(betaIdx);
  });
});

describe('mcp handleSearch', () => {
  useTestDb();

  it('rejects empty query', async () => {
    const r = await handleSearch({ query: '   ' });
    expect(textOf(r)).toContain('non-empty');
  });

  it('returns "no matches" message when graph is empty', async () => {
    const r = await handleSearch({ query: 'anything' });
    expect(textOf(r)).toContain('No memories matched');
    expect(textOf(r)).toContain('johnny_list');
  });

  it('formats prose with name, score, topics, snippet — never JSON', async () => {
    const m = await addMemory(
      'oauth-flow',
      'OAuth refresh flow',
      'How OAuth refresh tokens rotate vs. access tokens; PKCE notes.',
      'transcript body about oauth refresh tokens',
      '/tmp',
      80,
      ['oauth', 'jwt', 'refresh'],
      0,
    );
    await embedMemory(m);

    const r = await handleSearch({ query: 'oauth refresh', limit: 5 });
    const text = textOf(r);
    expect(text).toContain('oauth-flow');
    expect(text).toContain('Topics:');
    expect(text).toContain('oauth');
    expect(text).toContain('johnny_recall');
    // The output is not a JSON object — Claude reads prose.
    expect(text.trim().startsWith('{')).toBe(false);
    // A percentage score appears.
    expect(text).toMatch(/\d+%/);
  });

  it('orders results by cosine: query-aligned memory ranks above unrelated ones', async () => {
    const a = await addMemory('rust-borrow', 'Rust borrow checker',
      'Rust borrow checker rejected the lifetime annotation',
      't', '/tmp', 50, ['rust', 'lifetimes'], 0);
    const b = await addMemory('python-asyncio', 'Python asyncio',
      'asyncio event loops and task scheduling in Python',
      't', '/tmp', 50, ['python', 'asyncio'], 0);
    await embedMemory(a);
    await embedMemory(b);

    const r = await handleSearch({ query: 'Rust borrow checker rejected the lifetime annotation', limit: 5 });
    const text = textOf(r);
    expect(text.indexOf('rust-borrow')).toBeLessThan(text.indexOf('python-asyncio'));
  });

  it('falls back to FTS when no embeddings exist', async () => {
    // Memory created without embedMemory → no embedding stored. FTS searches
    // title/snapshot_name/transcript, so anchor the term in the transcript.
    await addMemory('fts-only', 'FTS only',
      'short summary',
      'rust borrow checker lifetime annotation', '/tmp', 30, ['rust'], 0);

    const r = await handleSearch({ query: 'borrow checker' });
    const text = textOf(r);
    // FTS path advertises itself in the header.
    expect(text).toContain('full-text');
    expect(text).toContain('fts-only');
  });

  it('honors limit', async () => {
    for (let i = 0; i < 8; i++) {
      const m = await addMemory(`mem-${i}`, `Title ${i}`, `summary ${i}`,
        `transcript ${i}`, '/tmp', 10, ['x'], 0);
      await embedMemory(m);
    }
    const r = await handleSearch({ query: 'mem', limit: 3 });
    const matches = textOf(r).match(/mem-\d+/g) ?? [];
    // 3 results. Repeats of "mem-N" can occur in the body, so just bound.
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(matches.length).toBeLessThanOrEqual(6);
  });
});

describe('mcp handleRecall co-reinforcement (Hebbian)', () => {
  useTestDb();

  async function seedChunkedMem(slug: string, text: string) {
    const m = await addMemory(slug, slug, 'summary', text, '/test', 50, [slug], 0);
    await embedMemory(m);
    await chunkAndPersistMemory(m.id, slug, text, { targetTokens: 30, maxTokens: 60, minTokens: 5 });
    return m;
  }

  it('creates bidirectional edges between co-recalled memories', async () => {
    await setState('active_session', 'co-reinforce-test');
    const a = await seedChunkedMem('alpha-mem', 'alpha beta gamma delta epsilon zeta eta theta');
    // Genuinely different text that still matches the query: write-time dedup stores identical
    // chunks once, and recall drops near-duplicate (>=0.97 cosine) tiles from one answer.
    const b = await seedChunkedMem('beta-mem', 'alpha beta lorem ipsum dolor sit amet consectetur');

    await handleRecall({ query: 'alpha beta', limit: 2 });

    const ab = await edgesDb.getEdge(a.id, b.id);
    const ba = await edgesDb.getEdge(b.id, a.id);
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
  });

  it('uses mcpRecallReinforcementDelta (0.5), not reinforcementDelta (1.0)', async () => {
    await setState('active_session', 'co-delta-test');
    const a = await seedChunkedMem('delta-a', 'same content here for delta test same content here');
    const b = await seedChunkedMem('delta-b', 'same content here lorem ipsum dolor sit amet consectetur adipiscing');

    await handleRecall({ query: 'same content delta', limit: 2 });

    const edge = await edgesDb.getEdge(a.id, b.id);
    expect(edge).not.toBeNull();
    // Weight should be ~0.5 (mcpRecallReinforcementDelta), not 1.0 (reinforcementDelta)
    expect(edge!.weight).toBeCloseTo(0.5, 1);
    expect(edge!.weight).toBeLessThan(1.0);
  });

  it('edge weight accumulates on repeated co-recall', async () => {
    await setState('active_session', 'accumulate-test');
    const a = await seedChunkedMem('acc-a', 'accumulate weight signal across repeated recalls');
    const b = await seedChunkedMem('acc-b', 'accumulate weight lorem ipsum dolor sit amet consectetur adipiscing');

    await handleRecall({ query: 'accumulate weight', limit: 2 });
    await handleRecall({ query: 'accumulate weight', limit: 2 });

    const edge = await edgesDb.getEdge(a.id, b.id);
    expect(edge!.weight).toBeCloseTo(1.0, 1); // 2 × 0.5
  });

  it('creates no edges when only one memory is returned', async () => {
    await setState('active_session', 'single-test');
    const a = await seedChunkedMem('solo-mem', 'unique solo memory content xylophone quartz');

    const before = await edgesDb.getTotalEdgeCount();
    await handleRecall({ query: 'xylophone quartz', limit: 1 });

    expect(await edgesDb.getTotalEdgeCount()).toBe(before);
  });

  it('respects mcpRecallMaxCoReinforce cap', async () => {
    await setState('active_session', 'cap-test');
    // Seed 8 memories with identical content so they all match the query
    const mems = [];
    for (let i = 0; i < 8; i++) {
      mems.push(await seedChunkedMem(`cap-mem-${i}`, `cap test shared content w${i}a w${i}b w${i}c w${i}d w${i}e w${i}f w${i}g`));
    }

    await handleRecall({ query: 'cap test shared content', limit: 8 });

    // With mcpRecallMaxCoReinforce=6, only the first 6 contribute.
    // Max directed edges from 6 nodes = 6*5 = 30. Should not exceed this.
    const total = await edgesDb.getTotalEdgeCount();
    expect(total).toBeLessThanOrEqual(30);
  });
});

describe('mcp handleRecall action_history telemetry (regression: Doctor "recalled" counter)', () => {
  // Doctor's "recalled Xh/Yd/Zw" figures (store/stats.ts RECALL_ACTIONS) are
  // action_history-derived. Before this fix, handleRecall only bumped
  // retrieval_count (memories.recordRetrieval) and recall_telemetry
  // (logRecallCall / the separate hint→recall conversion metric) — it never
  // wrote an action_history row, so MCP-driven recalls were invisible in the
  // Doctor's rolling hour/day/week recall counts even though "ever N/total"
  // (retrieval_count > 0) already reflected them correctly.
  useTestDb();

  beforeEach(() => {
    // recordAction()'s local-SQLite leg is the one it awaits synchronously
    // (the Postgres leg is intentionally fire-and-forget — see the comment
    // on recordAction in store/db/action-history.ts) — isolate it from the
    // real ~/.johnny/johnny.db the same way does.
    setDatabasePath(':memory:');
  });

  afterEach(() => {
    setDatabasePath(':memory:');
  });

  async function seedChunkedMem(slug: string, text: string) {
    const m = await addMemory(slug, slug, 'summary', text, '/test', 50, [slug], 0);
    await embedMemory(m);
    await chunkAndPersistMemory(m.id, slug, text, { targetTokens: 30, maxTokens: 60, minTokens: 5 });
    return m;
  }

  it('records an mcp_recall action_history row when a recall returns results', async () => {
    await setState('active_session', 'action-history-test');
    await incrementTurn('action-history-test');
    const mem = await seedChunkedMem('telemetry-mem', 'unique telemetry probe content walrus xenon');

    await handleRecall({ query: 'telemetry probe walrus', limit: 3 });

    const rows = await localQuery<{ action: string; session_id: string; matched_memory_id: string }>(
      `SELECT action, session_id, matched_memory_id FROM action_history WHERE action = 'mcp_recall'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('action-history-test');
    expect(rows[0].matched_memory_id).toBe(mem.id);
  });

  it('does not record an action_history row when a recall returns no matches', async () => {
    await setState('active_session', 'empty-recall-test');
    const r = await handleRecall({ query: 'nothing seeded matches this' });
    expect(textOf(r)).toContain('No memories matched');

    const rows = await localQuery<{ action: string }>(
      `SELECT action FROM action_history WHERE action = 'mcp_recall'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('mcp handleInvalidate', () => {
  useTestDb();

  it('returns not-found for an unknown slug', async () => {
    const r = await handleInvalidate({ name: 'ghost-slug' });
    expect(textOf(r)).toContain('No memory named');
  });

  it('increments invalidation_count on all incident edges', async () => {
    const m = await addMemory('invalid-hub', 'invalid-hub', 'hub summary', 'hub transcript', '/test', 10, ['hub'], 1);
    const a = await addMemory('inv-a', 'inv-a', 'a', 'a', '/test', 10, ['a'], 1);
    const b = await addMemory('inv-b', 'inv-b', 'b', 'b', '/test', 10, ['b'], 1);

    // Wire hub → a and b → hub
    await edgesDb.reinforceEdge(m.id, a.id, 1.0, 1);
    await edgesDb.reinforceEdge(b.id, m.id, 1.0, 1);

    await handleInvalidate({ name: 'invalid-hub' });

    expect((await edgesDb.getEdge(m.id, a.id))!.invalidation_count).toBe(1);
    expect((await edgesDb.getEdge(b.id, m.id))!.invalidation_count).toBe(1);
  });

  it('leaves unrelated edges untouched', async () => {
    const hub = await addMemory('hub2', 'hub2', 's', 't', '/test', 10, [], 1);
    const x   = await addMemory('xinv', 'xinv', 's', 't', '/test', 10, [], 1);
    const y   = await addMemory('yinv', 'yinv', 's', 't', '/test', 10, [], 1);

    await edgesDb.reinforceEdge(hub.id, x.id, 1.0, 1);
    await edgesDb.reinforceEdge(x.id, y.id, 1.0, 1); // unrelated edge

    await handleInvalidate({ name: 'hub2' });

    expect((await edgesDb.getEdge(x.id, y.id))!.invalidation_count).toBe(0);
  });

  it('reports count of edges marked in response text', async () => {
    const hub = await addMemory('hub3', 'hub3', 's', 't', '/test', 10, [], 1);
    const c   = await addMemory('cinv', 'cinv', 's', 't', '/test', 10, [], 1);
    await edgesDb.reinforceEdge(hub.id, c.id, 1.0, 1);

    const r = await handleInvalidate({ name: 'hub3' });
    expect(textOf(r)).toContain('1 edge');
  });

  it('handles a memory with zero edges gracefully', async () => {
    await addMemory('isolated-inv', 'isolated-inv', 's', 't', '/test', 10, [], 1);
    const r = await handleInvalidate({ name: 'isolated-inv' });
    expect(textOf(r)).toContain('0 edges');
  });
});

describe('mcp handleGraph', () => {
  useTestDb();

  it('reports zeros on empty graph', async () => {
    const text = textOf(await handleGraph());
    expect(text).toContain('Total Memories: 0');
    expect(text).toContain('Total Edges: 0');
    expect(text).toContain('Top Memories: none');
  });

  it('reports counts and top memories', async () => {
    const a = await addMemory('a', 'A', 'sa', 'ta', '/tmp', 10, [], 0);
    const b = await addMemory('b', 'B', 'sb', 'tb', '/tmp', 10, [], 0);
    await reinforceEdge(a.id, b.id, 0.5, 1);
    await memoriesDb.updateMemoryRank(a.id, 0.7, 1);

    const text = textOf(await handleGraph());
    expect(text).toContain('Total Memories: 2');
    expect(text).toContain('Total Edges: 1');
    expect(text).toMatch(/Top Memories: .*a/);
  });
});
