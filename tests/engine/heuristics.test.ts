import { describe, it, expect } from 'vitest';
import { runHeuristics } from '../../src/engine/heuristics.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { Memory } from '../../src/types.js';

function makeMemory(summary: string, topics: string[]): Memory {
  return {
    id: 'test-id', snapshotName: 'test-snap', summary, embedding: null,
    topics, projectPath: '/dev/test', tokenCount: 1000,
    retrievalCount: 5, lastRetrievedTurn: 100, lastRetrievedAt: '',
    createdAtTurn: 1, createdAt: '',
    outgoingEdges: {}, incomingEdges: {},
    rank: 0.5, rankUpdatedAtTurn: 100,
    transcript: '',
  };
}

const rokuMem = makeMemory('roku auth token refresh debugging', ['roku', 'auth', 'token', 'refresh']);
const musicMem = makeMemory('navidrome music server setup on aws', ['navidrome', 'music', 'aws', 'server']);

describe('runHeuristics — returns raw signals (no categorical intent)', () => {
  it('no CWD change, matching keywords → positive keywordScore, no context signals', () => {
    const r = runHeuristics('fix the token refresh endpoint', '/dev/roku', '/dev/roku', null, [rokuMem], DEFAULT_CONFIG);
    expect(r.keywordScore).toBeGreaterThan(0);
    expect(r.cwdChanged).toBe(false);
    expect(r.longGap).toBe(false);
    expect(r.isNewTopic).toBe(false);
    expect(r.isAmbiguous).toBe(false);
  });

  it('CWD changed + keyword match → cwdChanged=true + matchedMemory set', () => {
    const r = runHeuristics('check navidrome logs on aws', '/dev/music', '/dev/roku', null, [rokuMem, musicMem], DEFAULT_CONFIG);
    expect(r.cwdChanged).toBe(true);
    expect(r.matchedMemory).not.toBeNull();
    expect(r.keywordScore).toBeGreaterThan(0.1);
    expect(r.isNewTopic).toBe(false);
  });

  it('CWD changed + no keyword match → isNewTopic=true', () => {
    const r = runHeuristics('help me with python scripts', '/dev/scripts', '/dev/roku', null, [rokuMem], DEFAULT_CONFIG);
    expect(r.cwdChanged).toBe(true);
    expect(r.isNewTopic).toBe(true);
    expect(r.matchedMemory).toBeNull();
  });

  it('long time gap → longGap=true', () => {
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const r = runHeuristics('navidrome music server setup', '/dev/music', '/dev/music', longAgo, [musicMem], DEFAULT_CONFIG);
    expect(r.longGap).toBe(true);
    expect(r.keywordScore).toBeGreaterThan(0.1);
  });

  it('no memories → keywordScore=0, no match', () => {
    const r = runHeuristics('hello', '/dev/test', '/dev/test', null, [], DEFAULT_CONFIG);
    expect(r.keywordScore).toBe(0);
    expect(r.matchedMemory).toBeNull();
    expect(r.isAmbiguous).toBe(false);
  });

  it('two similar memories from different projects → isAmbiguous=true when scores are close', () => {
    // Use distinct first topics so the same-topic shortcut doesn't fire.
    const mem1 = makeMemory('roku auth debugging', ['auth', 'roku', 'debug']);
    mem1.projectPath = '/dev/project-a';
    const mem2 = makeMemory('roku token refresh issue', ['token', 'roku', 'refresh']);
    mem2.projectPath = '/dev/project-b';
    const r = runHeuristics('roku auth token', '/dev/test', '/dev/test', null, [mem1, mem2], DEFAULT_CONFIG);
    expect(r.isAmbiguous).toBe(true);
    expect(r.candidates.length).toBe(2);
  });
});
