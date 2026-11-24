import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { buildDigest, buildSyntheticFrame, recommendMemory } from '../../src/actions/recommend-memory.js';
import type { MemoryNode } from '../../src/types.js';

function mockMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem_abc',
    snapshotName: 'roku-auth',
    title: 'roku-auth',
    summary: 'figuring out jellyfin roku api wake flow',
    projectPath: '/dev/jellyfin-roku',
    tokenCount: 1234,
    topics: ['roku', 'jellyfin', 'auth', 'wake', 'api'],
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: 10,
    createdAt: '2026-04-18T00:00:00.000Z',
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0,
    rankUpdatedAtTurn: 0,
    ...overrides,
  };
}

describe('recommend_memory · buildDigest (Form 3 + load-assertion)', () => {
  it('renders Form 3 prose with snapshot name, topics, summary as Digest', () => {
    const digest = buildDigest(mockMemory(), 0.85);
    expect(digest).toContain('Top match');
    expect(digest).toContain('Title: roku-auth');
    expect(digest).toContain('Topics: roku, jellyfin, auth, wake, api');
    expect(digest).toContain('Confidence: high (85%)');
    expect(digest).toContain('Date: 2026-04-18');
    expect(digest).toContain('Digest: figuring out jellyfin roku api wake flow');
  });

  it('appends the load-assertion line so Claude knows the body is in transcript', () => {
    const digest = buildDigest(mockMemory(), 0.82);
    expect(digest.trim().endsWith('(Loaded into transcript — full body available from next turn.)')).toBe(true);
  });

  it('omits percentage when score is null (heuristic-only path)', () => {
    const digest = buildDigest(mockMemory(), null);
    expect(digest).toContain('Confidence: high');
    expect(digest).not.toMatch(/Confidence: high \(\d+%\)/);
    // Still asserts the load
    expect(digest).toContain('(Loaded into transcript');
  });

  it('caps topic list at 8 in the rendered Topics line', () => {
    const mem = mockMemory({
      topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
    });
    const digest = buildDigest(mem, 0.9);
    expect(digest).toContain('Topics: a, b, c, d, e, f, g, h');
    expect(digest).not.toMatch(/Topics:.*\bi\b/);
  });

  it('includes call instructions inviting johnny_recall pulls', () => {
    const digest = buildDigest(mockMemory(), 0.9);
    expect(digest).toContain('johnny_recall');
  });

  it('renders Form 3 even at the realistic recommend_memory lower band (0.70)', () => {
    const digest = buildDigest(mockMemory(), 0.70);
    expect(digest).toContain('Top match');
    expect(digest).toContain('Digest:');
    expect(digest).not.toContain('Possibly relevant');
  });

  it('renders Form 3 even at sub-normal scores (0.40) — by-policy override', () => {
    const digest = buildDigest(mockMemory(), 0.40);
    expect(digest).toContain('Top match');
    expect(digest).toContain('Digest:');
    expect(digest).not.toMatch(/^Loaded context:/);
  });
});

describe('recommend_memory · buildSyntheticFrame (JSONL schema fidelity)', () => {
  const NOW = '2026-04-18T12:00:00.000Z';
  const OPENER = '11111111-1111-1111-1111-111111111111';
  const ACK = '22222222-2222-2222-2222-222222222222';

  it('opener has the required Claude Code transcript fields', () => {
    const { opener } = buildSyntheticFrame(
      mockMemory(),
      'sess_1',
      '/some/cwd',
      NOW,
      OPENER,
      ACK,
    );
    expect(opener).toMatchObject({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      timestamp: NOW,
      uuid: OPENER,
      sessionId: 'sess_1',
      cwd: '/some/cwd',
    });
    expect((opener as any).message).toEqual({
      role: 'user',
      content: expect.stringContaining('[johnny] loaded context: roku-auth'),
    });
    expect((opener as any).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('ack has assistant role and parentUuid chained to opener', () => {
    const { ack } = buildSyntheticFrame(
      mockMemory(),
      'sess_1',
      '/cwd',
      NOW,
      OPENER,
      ACK,
    );
    expect(ack).toMatchObject({
      parentUuid: OPENER,
      isSidechain: false,
      type: 'assistant',
      timestamp: NOW,
      uuid: ACK,
      sessionId: 'sess_1',
    });
    expect((ack as any).message.role).toBe('assistant');
    expect((ack as any).message.content).toEqual([
      { type: 'text', text: expect.stringContaining('Acknowledged') },
    ]);
  });

  it('serializes to one JSON line each (JSONL-safe)', () => {
    const { opener, ack } = buildSyntheticFrame(mockMemory(), 's', '/c');
    const openerLine = JSON.stringify(opener);
    const ackLine = JSON.stringify(ack);
    expect(openerLine).not.toContain('\n');
    expect(ackLine).not.toContain('\n');
    expect(() => JSON.parse(openerLine)).not.toThrow();
    expect(() => JSON.parse(ackLine)).not.toThrow();
  });

  it('generates fresh UUIDs when not provided', () => {
    const a = buildSyntheticFrame(mockMemory(), 's', '/c');
    const b = buildSyntheticFrame(mockMemory(), 's', '/c');
    expect((a.opener as any).uuid).not.toBe((b.opener as any).uuid);
    expect((a.ack as any).parentUuid).toBe((a.opener as any).uuid);
  });
});

describe('recommend_memory · telemetry (regression: hint_telemetry empty)', () => {
  useTestDb();

  it('writes a hint_telemetry row with form="recommend_memory" on every emission', async () => {
    const telemetry = await import('../../src/store/db/telemetry.js');
    const sessions = await import('../../src/store/db/sessions.js');
    await sessions.createSession({ sessionId: 'sess-rec-tel' });

    const before = (await telemetry.getHintTelemetry(50)).length;
    const out = await recommendMemory(
      'pick up where we left off on roku-auth',
      mockMemory(),
      '/tmp/no-such-transcript.jsonl', // ENOENT path → digest-only fallback
      'sess-rec-tel',
      '/some/cwd',
      0.62,
    );
    const after = await telemetry.getHintTelemetry(50);

    expect(out.additionalContext).toBeDefined();
    expect(after.length).toBe(before + 1);
    expect(after[0].form).toBe('recommend_memory');
    expect(after[0].session_id).toBe('sess-rec-tel');
    expect(after[0].top_score).toBe(0.62);
    const ids = JSON.parse(after[0].suggested_memory_ids ?? '[]');
    expect(ids).toEqual(['mem_abc']);
  });

  it('still records telemetry when topScore is null (by-policy path)', async () => {
    const telemetry = await import('../../src/store/db/telemetry.js');
    const sessions = await import('../../src/store/db/sessions.js');
    await sessions.createSession({ sessionId: 'sess-rec-null' });

    await recommendMemory(
      'continue',
      mockMemory(),
      '/tmp/none.jsonl',
      'sess-rec-null',
      '/cwd',
      null,
    );

    const rows = await telemetry.getHintTelemetry(50);
    expect(rows[0].form).toBe('recommend_memory');
    expect(rows[0].top_score).toBeNull();
  });
});
