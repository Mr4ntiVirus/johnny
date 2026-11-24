import { describe, it, expect } from 'vitest';
import { buildBootstrapHint } from '../../src/engine/bootstrap-hint.js';
import type { MemoryGraph, MemoryNode } from '../../src/types.js';

function makeMem(overrides: Partial<MemoryNode> & { id: string }): MemoryNode {
  return {
    id: overrides.id,
    snapshotName: overrides.id,
    title: overrides.id,
    summary: 'summary',
    projectPath: '/proj/a',
    tokenCount: 100,
    topics: [],
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: 1,
    createdAt: '2026-04-10T00:00:00.000Z',
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0.15,
    rankUpdatedAtTurn: 0,
    ...overrides,
  };
}

function makeGraph(...mems: MemoryNode[]): MemoryGraph {
  const memories: Record<string, MemoryNode> = {};
  for (const m of mems) memories[m.id] = m;
  return { version: 1, rankUpdatedAtTurn: 0, memories };
}

describe('engine/bootstrap-hint · scoping & emission gate', () => {
  it('returns null when the project has no memories', () => {
    const graph = makeGraph(makeMem({ id: 'm1', projectPath: '/other/path' }));
    expect(buildBootstrapHint(graph, '/proj/a')).toBeNull();
  });

  it('returns null on an empty graph', () => {
    expect(buildBootstrapHint(makeGraph(), '/proj/a')).toBeNull();
  });

  it('only includes memories whose projectPath matches cwd', () => {
    const graph = makeGraph(
      makeMem({ id: 'in-proj', projectPath: '/proj/a', topics: ['rust'] }),
      makeMem({ id: 'other-proj', projectPath: '/proj/b', topics: ['python'] }),
    );
    const hint = buildBootstrapHint(graph, '/proj/a');
    expect(hint).not.toBeNull();
    // Cluster topics reflect scoped memories — 'rust' from in-proj, no 'python' from other-proj.
    expect(hint!.text).toContain('rust');
    expect(hint!.text).not.toContain('python');
  });
});

describe('engine/bootstrap-hint · recent work', () => {
  it('orders recents by most-recent-touched (lastRetrievedAt or createdAt)', () => {
    const now = '2026-04-21T00:00:00.000Z';
    const graph = makeGraph(
      makeMem({ id: 'old',     createdAt: '2026-01-01T00:00:00.000Z' }),
      makeMem({ id: 'pulled',  createdAt: '2026-01-02T00:00:00.000Z', lastRetrievedAt: '2026-04-20T00:00:00.000Z' }),
      makeMem({ id: 'newest',  createdAt: '2026-04-15T00:00:00.000Z' }),
    );
    const hint = buildBootstrapHint(graph, '/proj/a', { nowIso: now });
    const text = hint!.text;
    // 'newest' and 'old' are non-first recents; their IDs appear in "before that:".
    // 'pulled' is first (yesterday per nowIso) — its date appears before the others.
    expect(text.indexOf('newest')).toBeLessThan(text.indexOf('old'));
    // The first item ('pulled') renders as "yesterday: ..." which precedes "before that:"
    expect(text).toContain('yesterday');
  });

  it('caps recents at recentLimit', () => {
    const mems: MemoryNode[] = [];
    for (let i = 0; i < 8; i++) {
      mems.push(makeMem({
        id: `m${i}`,
        title: `mem-${i}`,
        createdAt: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      }));
    }
    const hint = buildBootstrapHint(makeGraph(...mems), '/proj/a', { recentLimit: 2, nowIso: '2026-05-01T00:00:00.000Z' });
    // 2 recents shown (most recent: m7, m6 in "before that:")
    // m7 is first (shown as apr 8 date) and m6 appears in "before that:"
    expect(hint!.text).toContain('m6');
    expect(hint!.text).not.toContain('m5');
    expect(hint!.surfacedMemoryIds).toEqual(['m7', 'm6']);
  });

  it('includes the most recent date in the opening narrative', () => {
    const graph = makeGraph(makeMem({
      id: 'm1', title: 'aws-profile-amnesia',
      summary: 'aws-profile-amnesia',
      createdAt: '2026-04-19T00:00:00.000Z',
    }));
    // nowIso is 36 hours after createdAt → diffDays = floor(1.5) = 1 → "yesterday"
    const hint = buildBootstrapHint(graph, '/proj/a', { nowIso: '2026-04-20T12:00:00.000Z' });
    expect(hint!.text).toContain('yesterday');
    expect(hint!.text).toContain('aws-profile-amnesia');
  });
});

describe('engine/bootstrap-hint · landscape clusters', () => {
  it('aggregates topic counts and shows them inline', () => {
    const graph = makeGraph(
      makeMem({ id: 'm1', topics: ['aws', 'iam'] }),
      makeMem({ id: 'm2', topics: ['aws', 'lambda'] }),
      makeMem({ id: 'm3', topics: ['lambda'] }),
    );
    const hint = buildBootstrapHint(graph, '/proj/a', { topicsPerCluster: 3, clusterLimit: 1 });
    // Top topics appear inline in the cluster summary line
    expect(hint!.text).toContain('aws');
    expect(hint!.text).toContain('lambda');
  });

  it('caps clusters at clusterLimit and groups topics in chunks of topicsPerCluster', () => {
    const graph = makeGraph(
      makeMem({ id: 'm1', topics: ['alpha', 'bravo', 'charlie', 'delta', 'zulu', 'foxtrot'] }),
      makeMem({ id: 'm2', topics: ['alpha', 'bravo', 'charlie', 'delta', 'zulu', 'foxtrot'] }),
    );
    const hint = buildBootstrapHint(graph, '/proj/a', {
      topicsPerCluster: 2,
      clusterLimit: 2,
    });
    // Top 4 topics shown across 2 clusters (2 per cluster), inline.
    // 'zulu' and 'foxtrot' are outside the limit and should not appear.
    expect(hint!.text).toContain('alpha');
    expect(hint!.text).toContain('bravo');
    expect(hint!.text).toContain('charlie');
    expect(hint!.text).toContain('delta');
    expect(hint!.text).not.toContain('zulu');
    expect(hint!.text).not.toContain('foxtrot');
  });

  it('skips the hot-topics line when no memory has any topics', () => {
    const graph = makeGraph(makeMem({ id: 'm1', topics: [] }));
    const hint = buildBootstrapHint(graph, '/proj/a');
    expect(hint!.text).not.toContain('hot:');
    // Still emits header + recents + call instructions.
    expect(hint!.text).toContain('johnny_recall');
  });

  it('returns clusterTopics flat list of topic names actually shown', () => {
    const graph = makeGraph(
      makeMem({ id: 'm1', topics: ['aws', 'iam', 'cdk'] }),
      makeMem({ id: 'm2', topics: ['aws', 'lambda'] }),
    );
    const hint = buildBootstrapHint(graph, '/proj/a', { topicsPerCluster: 2, clusterLimit: 1 });
    // Top 2 topics across the project: aws (2) + lambda or cdk or iam (1 each — alphabetical).
    expect(hint!.clusterTopics).toHaveLength(2);
    expect(hint!.clusterTopics[0]).toBe('aws');
  });
});

describe('engine/bootstrap-hint · prose shape', () => {
  it('uses cwd basename as project label in opening line', () => {
    const graph = makeGraph(makeMem({ id: 'm1', topics: ['x'], projectPath: '/dev/wake-portal' }));
    const hint = buildBootstrapHint(graph, '/dev/wake-portal');
    expect(hint!.text).toContain('wake-portal/');
    expect(hint!.text).not.toContain('/dev/wake-portal/'); // basename only
  });

  it('always ends with MCP call instructions naming all three tools', () => {
    const graph = makeGraph(makeMem({ id: 'm1', topics: ['x'] }));
    const hint = buildBootstrapHint(graph, '/proj/a');
    expect(hint!.text).toContain('johnny_list');
    expect(hint!.text).toContain('johnny_search');
    expect(hint!.text).toContain('johnny_recall');
  });

  it('pluralizes memory count correctly', () => {
    const single = buildBootstrapHint(makeGraph(makeMem({ id: 'm1' })), '/proj/a');
    expect(single!.text).toMatch(/1 memory\./);

    const multi = buildBootstrapHint(
      makeGraph(makeMem({ id: 'm1' }), makeMem({ id: 'm2' })),
      '/proj/a',
    );
    expect(multi!.text).toMatch(/2 memories\./);
  });

  it('lands within the ≤500-token additionalContext budget for realistic loads', () => {
    // 20 memories, each with 4 topics, 50-char titles — heavier than the
    // documented "wake-portal: 14 + 8 + 5 + 3" sample shape (~190 tokens).
    const mems: MemoryNode[] = [];
    for (let i = 0; i < 20; i++) {
      mems.push(makeMem({
        id: `m${i}`,
        title: `memory-${i}-with-a-fairly-descriptive-title-here`,
        topics: [`topic-${i % 5}`, `area-${i % 3}`, 'common', 'shared'],
        createdAt: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }));
    }
    const hint = buildBootstrapHint(makeGraph(...mems), '/proj/a');
    // Rough token estimate: chars / 4. 500 tokens = ~2000 chars.
    expect(hint!.text.length).toBeLessThan(2000);
  });
});
