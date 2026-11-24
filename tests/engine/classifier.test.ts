// Tests the LLM label → llmVote mapping in runClassifier.
// Mocks rankBySimilarity to a fixed low score (0.30) so the LLM band always
// applies, and controls isOllamaOnline + classify to drive each label path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/llm.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/utils/llm.js')>();
  return {
    ...mod,
    isOllamaOnline: vi.fn().mockResolvedValue(true),
    classify: vi.fn(),
  };
});

vi.mock('../../src/engine/embedder.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/engine/embedder.js')>();
  return {
    ...mod,
    rankBySimilarity: vi.fn().mockImplementation(async (_prompt: string, mems: unknown[]) =>
      mems.map((m, i) => ({ memory: m, similarity: 0.30 + i * 0.01 })),
    ),
  };
});

import { runClassifier } from '../../src/engine/classifier.js';
import { classify } from '../../src/utils/llm.js';
import type { MemoryNode } from '../../src/types.js';

const STUB_MEMORY: MemoryNode = {
  id: 'mem-stub',
  snapshotName: 'roku-auth',
  title: 'Roku auth',
  summary: 'auth token refresh',
  projectPath: '/tmp/roku',
  tokenCount: 500,
  topics: ['roku', 'auth'],
  retrievalCount: 0,
  lastRetrievedTurn: 0,
  lastRetrievedAt: '',
  createdAtTurn: 1,
  createdAt: '2026-05-01T00:00:00Z',
  outgoingEdges: {},
  incomingEdges: {},
  rank: 0,
  rankUpdatedAtTurn: 0,
};

const CONTEXT = 'working on roku auth token refresh';

describe('classifier — LLM label → llmVote mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(classify as (...args: unknown[]) => Promise<string>).mockResolvedValue('continuation');
  });

  it("'topic_switch' → llmVote='switch', source='llm'", async () => {
    vi.mocked(classify as (...args: unknown[]) => Promise<string>).mockResolvedValueOnce('topic_switch');
    const r = await runClassifier('migrate postgres schema', [STUB_MEMORY], CONTEXT);
    expect(r.llmVote).toBe('switch');
    expect(r.rawLabel).toBe('topic_switch');
    expect(r.source).toBe('llm');
  });

  it("'new_topic' → llmVote='new', source='llm'", async () => {
    vi.mocked(classify as (...args: unknown[]) => Promise<string>).mockResolvedValueOnce('new_topic');
    const r = await runClassifier('start a brand new project', [STUB_MEMORY], CONTEXT);
    expect(r.llmVote).toBe('new');
    expect(r.rawLabel).toBe('new_topic');
    expect(r.source).toBe('llm');
  });

  it("'ambiguous' → llmVote=null (abstain), source='embedding'", async () => {
    vi.mocked(classify as (...args: unknown[]) => Promise<string>).mockResolvedValueOnce('ambiguous');
    const r = await runClassifier('something unclear', [STUB_MEMORY], CONTEXT);
    expect(r.llmVote).toBe(null);
    expect(r.rawLabel).toBe('ambiguous');
    expect(r.source).toBe('embedding');
  });

  it("'continuation' → llmVote='continue', source='llm'", async () => {
    vi.mocked(classify as (...args: unknown[]) => Promise<string>).mockResolvedValueOnce('continuation');
    const r = await runClassifier('fix the 401 error', [STUB_MEMORY], CONTEXT);
    expect(r.llmVote).toBe('continue');
    expect(r.rawLabel).toBe('continuation');
    expect(r.source).toBe('llm');
  });
});
