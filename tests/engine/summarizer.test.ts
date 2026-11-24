import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as url from 'node:url';

// Tests run with JOHNNY_LLM_MOCK=1 — summarizeSession uses keywordSlug fallback.
// We test the pure helpers directly by importing from the source.
// extractUserMessages and keywordSlug are internal; we test their observable
// effects via summarizeSession with the fixture files.

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures');

// We need JOHNNY_LLM_MOCK set before importing so MOCK_MODE is true.
// vitest.config / env file handles this; confirm it's set.
it('MOCK_MODE is active', () => {
  expect(process.env.JOHNNY_LLM_MOCK).toBeTruthy();
});

describe('summarizeSession — mock mode', () => {
  it('returns a slug and summary for a normal session', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const result = await summarizeSession(path.join(FIXTURES, 'normal-session.jsonl'));
    expect(result.slug).toMatch(/^[a-z0-9-]+$/);
    expect(result.slug.length).toBeGreaterThan(3);
    expect(result.summary).toBeTruthy();
  });

  it('falls back gracefully on missing file', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const result = await summarizeSession('/does/not/exist.jsonl');
    expect(result.slug).toMatch(/session-\d{4}/); // session-MMDD fallback
    expect(result.summary).toBe('empty session');
  });

  it('slug contains only safe characters', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const result = await summarizeSession(path.join(FIXTURES, 'normal-session.jsonl'));
    // keywordSlug: words joined by hyphens, no spaces or specials
    expect(result.slug).not.toMatch(/[^a-z0-9-]/);
  });

  it('slug is non-empty even for minimal user content', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const result = await summarizeSession(path.join(FIXTURES, 'near-compaction.jsonl'));
    expect(result.slug.length).toBeGreaterThan(0);
  });
});

describe('summarizeSession — snapshot deltas (rawContent)', () => {
  const asst = (text: string) => JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const user = (text: string) => JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: text } });

  it('summarises only the delta it is given, not the file on disk', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const r = await summarizeSession('/does/not/exist.jsonl', { rawContent: user('Please refactor the relay connection pooling code') });
    expect(r.summary).not.toBe('empty session');
    expect(r.slug).toMatch(/refactor|relay|connection|pooling/);
  });

  it('a delta with no user message (autonomous stretch) is summarised from the assistant, not called empty', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const r = await summarizeSession('/does/not/exist.jsonl', {
      rawContent: [asst('Implemented the chunk index and verified the purge on a rehearsal copy of the database'),
                   asst('Rebuilt the dist output and restarted the daemon on the new build')].join('\n'),
    });
    expect(r.summary).not.toBe('empty session');
    expect(r.title).not.toBe('Empty coding session');
  });

  it('a delta with neither is still reported as empty', async () => {
    const { summarizeSession } = await import('../../src/engine/summarizer.js');
    const r = await summarizeSession('/does/not/exist.jsonl', { rawContent: JSON.stringify({ type: 'mode', value: 'x' }) });
    expect(r.summary).toBe('empty session');
  });
});
