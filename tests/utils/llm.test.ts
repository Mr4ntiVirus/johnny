import { describe, it, expect, beforeAll } from 'vitest';

// Force mock mode for all tests
beforeAll(() => { process.env.JOHNNY_LLM_MOCK = '1'; });

describe('llm mock mode', () => {
  it('embed returns a non-empty vector', async () => {
    const { embed } = await import('../../src/utils/llm.js');
    const vec = await embed('roku auth token');
    expect(vec.length).toBeGreaterThan(0);
    // Should be a unit vector (norm ≈ 1)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it('same text → same embedding (deterministic)', async () => {
    const { embed } = await import('../../src/utils/llm.js');
    const a = await embed('hello world');
    const b = await embed('hello world');
    expect(a).toEqual(b);
  });

  it('different texts → different embeddings', async () => {
    const { embed } = await import('../../src/utils/llm.js');
    const a = await embed('roku authentication');
    const b = await embed('navidrome music server');
    expect(a).not.toEqual(b);
  });

  it('classify returns continuation in mock mode', async () => {
    const { classify } = await import('../../src/utils/llm.js');
    const result = await classify('fix the auth bug', 'working on roku auth');
    expect(result).toBe('continuation');
  });

  it('isOllamaOnline returns false in mock mode', async () => {
    const { isOllamaOnline } = await import('../../src/utils/llm.js');
    expect(await isOllamaOnline()).toBe(false);
  });
});

describe('classifyOutcomeFromKeywords', () => {
  it('classifies "it worked" as praise', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('it worked')).toBe('praise');
  });

  it('classifies "that worked" as praise', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('that worked')).toBe('praise');
  });

  it('classifies "it works" as praise', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('it works')).toBe('praise');
  });

  it('classifies "works now" as praise', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('works now')).toBe('praise');
  });

  it('classifies "data loss" as failure', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('data loss detected')).toBe('failure');
  });

  it('returns null for neutral prompts', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('can you add a new feature')).toBeNull();
  });

  it('is case-insensitive', async () => {
    const { classifyOutcomeFromKeywords } = await import('../../src/utils/llm.js');
    expect(classifyOutcomeFromKeywords('IT WORKED')).toBe('praise');
  });
});

describe('classifyOutcome keyword pre-filter (mock mode)', () => {
  it('"it worked" returns praise even with failure-flavored assistant text', async () => {
    const { classifyOutcome } = await import('../../src/utils/llm.js');
    const assistantText = 'I apologize for the error. The authentication was broken because the token lacked required scopes. I fixed the problem.';
    expect(await classifyOutcome('it worked', assistantText)).toBe('praise');
  });

  it('neutral prompt in mock mode still returns neutral', async () => {
    const { classifyOutcome } = await import('../../src/utils/llm.js');
    expect(await classifyOutcome('can you check the logs', 'here are the logs')).toBe('neutral');
  });
});

describe('parseClassifyLabel', () => {
  it('exact matches for all valid labels', async () => {
    const { parseClassifyLabel } = await import('../../src/utils/llm.js');
    expect(parseClassifyLabel('continuation')).toBe('continuation');
    expect(parseClassifyLabel('topic_switch')).toBe('topic_switch');
    expect(parseClassifyLabel('new_topic')).toBe('new_topic');
    expect(parseClassifyLabel('ambiguous')).toBe('ambiguous');
  });

  it('tolerates surrounding whitespace and case', async () => {
    const { parseClassifyLabel } = await import('../../src/utils/llm.js');
    expect(parseClassifyLabel('  Continuation\n')).toBe('continuation');
    expect(parseClassifyLabel('TOPIC_SWITCH')).toBe('topic_switch');
  });

  it('strips punctuation noise', async () => {
    const { parseClassifyLabel } = await import('../../src/utils/llm.js');
    expect(parseClassifyLabel('new_topic.')).toBe('new_topic');
    expect(parseClassifyLabel('Continuation\n')).toBe('continuation');
  });

  it('finds a label embedded in a phrase', async () => {
    const { parseClassifyLabel } = await import('../../src/utils/llm.js');
    expect(parseClassifyLabel('the answer is topic_switch')).toBe('topic_switch');
  });

  it('falls back to ambiguous for genuine garbage', async () => {
    const { parseClassifyLabel } = await import('../../src/utils/llm.js');
    expect(parseClassifyLabel("I'm not sure what you mean")).toBe('ambiguous');
  });
});
