import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { offer } from '../../src/actions/offer.js';
import * as sessionsDb from '../../src/store/db/sessions.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { MemoryNode, JohnnyConfig } from '../../src/types.js';

function mockMemory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'mem_offer',
    snapshotName: 'phase-g-design',
    title: 'phase-g-design',
    summary: 'design discussion locking the Phase G two-trigger ladder',
    projectPath: '/dev/johnny',
    tokenCount: 800,
    topics: ['phase-g', 'design', 'recall', 'mcp'],
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: 5,
    createdAt: '2026-04-25T00:00:00.000Z',
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0,
    rankUpdatedAtTurn: 0,
    ...overrides,
  };
}

function cfg(overrides: Partial<JohnnyConfig> = {}): JohnnyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe('actions/offer', () => {
  useTestDb();

  it('emits a Form 1 hint with title, topics, and recall instructions', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    const out = await offer(mockMemory(), 0.62, 's', 10, cfg());
    expect(out.additionalContext).toBeDefined();
    const ac = out.additionalContext!;
    expect(ac).toContain('Possibly relevant memories:');
    expect(ac).toContain('Title: phase-g-design');
    expect(ac).toContain('Topics: phase-g, design, recall, mcp');
    expect(ac).toContain('johnny_recall');
    // Form 1, not Form 3 — no "Top match" header.
    expect(ac).not.toContain('Top match');
  });

  it('records the memory as surfaced at the current turn', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await offer(mockMemory(), 0.62, 's', 10, cfg());
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'mem_offer')).toBe(10);
  });

  it('renders a date, topics, and percentage in the systemMessage status line', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    const out = await offer(mockMemory(), 0.62, 's', 10, cfg());
    expect(out.systemMessage).toBeDefined();
    // New format: "◇  apr 25 · phase-g/design (62%)" — date + top 2 topics + score
    expect(out.systemMessage!).toContain('phase-g');
    expect(out.systemMessage!).toContain('62%');
  });

  it('held back when memory is in cooldown (recent surface, sub-shift similarity)', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setMemorySurfaced('s', 'mem_offer', 9); // surfaced last turn
    const out = await offer(mockMemory(), 0.55, 's', 10, cfg({ cooldownTurns: 6, subjectShiftThreshold: 0.78 }));
    expect(out.additionalContext).toBeUndefined();
    expect(out.systemMessage).toBeUndefined();
  });

  it('cooldown-suppressed offer does not bump retrievalCount (graph stays accurate)', async () => {
    const memoriesDb = await import('../../src/store/db/memories.js');
    const id = await memoriesDb.createMemory({
      id: 'mem_cooldown_a',
      snapshotName: 'phase-g-design',
      title: 'phase-g-design',
      summary: 'design discussion',
      tokenCount: 800,
    });

    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setMemorySurfaced('s', id, 9);

    const before = (await memoriesDb.getMemory(id))!;
    await offer(mockMemory({ id }), 0.55, 's', 10, cfg({ cooldownTurns: 6, subjectShiftThreshold: 0.78 }));
    const after = (await memoriesDb.getMemory(id))!;

    expect(after.retrieval_count).toBe(before.retrieval_count);          // unchanged
    expect(after.last_retrieved_turn).toBe(before.last_retrieved_turn);  // unchanged
  });

  it('shipped offer bumps retrievalCount + lastRetrievedTurn', async () => {
    const memoriesDb = await import('../../src/store/db/memories.js');
    const id = await memoriesDb.createMemory({
      id: 'mem_cooldown_b',
      snapshotName: 'phase-g-design',
      title: 'phase-g-design',
      summary: 'design discussion',
      tokenCount: 800,
    });

    await sessionsDb.createSession({ sessionId: 's' });
    const before = (await memoriesDb.getMemory(id))!;
    await offer(mockMemory({ id }), 0.62, 's', 10, cfg());
    const after = (await memoriesDb.getMemory(id))!;

    expect(after.retrieval_count).toBe(before.retrieval_count + 1);
    expect(after.last_retrieved_turn).toBe(10);
  });

  it('breaks cooldown when similarity is bullseye (≥ subjectShiftThreshold)', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setMemorySurfaced('s', 'mem_offer', 9);
    const out = await offer(mockMemory(), 0.85, 's', 10, cfg({ cooldownTurns: 6, subjectShiftThreshold: 0.78 }));
    expect(out.additionalContext).toBeDefined();
    expect(out.additionalContext!).toContain('phase-g-design');
  });

  it('breaks cooldown when enough turns elapse (time-based)', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await sessionsDb.setMemorySurfaced('s', 'mem_offer', 2);
    // 10 - 2 = 8 ≥ cooldownTurns (6) → eligible regardless of similarity
    const out = await offer(mockMemory(), 0.65, 's', 10, cfg({ cooldownTurns: 6, subjectShiftThreshold: 0.78 }));
    expect(out.additionalContext).toBeDefined();
  });

  it('first surface (never seen this session) is not blocked by cooldown', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    const out = await offer(mockMemory(), 0.65, 's', 10, cfg());
    expect(out.additionalContext).toBeDefined();
    expect(await sessionsDb.getMemorySurfaceTurn('s', 'mem_offer')).toBe(10);
  });

  it('returns empty output when score falls below offerThreshold', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    // Below configured offerThreshold — formatHint filters it out.
    const out = await offer(mockMemory(), 0.20, 's', 10, cfg({ offerThreshold: 0.50 }));
    expect(out.additionalContext).toBeUndefined();
  });

  it('logs telemetry with the offer form tag', async () => {
    await sessionsDb.createSession({ sessionId: 's' });
    await offer(mockMemory(), 0.62, 's', 10, cfg());
    const telemetry = await import('../../src/store/db/telemetry.js');
    const rows = await telemetry.getHintTelemetry(5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].form).toBe('offer');
  });
});
