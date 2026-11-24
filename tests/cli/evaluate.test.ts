// Integration tests for the evaluate hook's core decision pipeline.
// Drives evaluateHook(input) with seeded DB + fixture transcripts and asserts
// on the HookOutput shape and post-call session-map state. LLM mocked via
// JOHNNY_LLM_MOCK=1 (set globally in vitest.config.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { evaluateHook } from '../../src/cli/evaluate.js';
import { addMemory } from '../../src/store/memory.js';
import { embedMemory } from '../../src/engine/embedder.js';
import { setActiveSession, getSessionEntry } from '../../src/store/session-map.js';
import type { HookInput } from '../../src/types.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function makePayload(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: 'test-session-1',
    transcript_path: path.join(FIXTURES, 'normal-session.jsonl'),
    cwd: '/tmp/project-a',
    prompt: 'continue working on this',
    ...overrides,
  };
}

describe('evaluateHook', () => {
  useTestDb();

  // CMV writes snapshots to ~/.cmv/. Sandbox HOME so tests don't touch the
  // real user dir when actions like snapshot_passthrough or hard_switch fire.
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-eval-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it('returns a systemMessage with johnny stamp on a fresh session', async () => {
    const output = await evaluateHook(makePayload());
    expect(output.systemMessage).toBeTruthy();
    // Every non-bypassed response is stamped with "johnny" on the first line.
    expect(output.systemMessage).toMatch(/johnny/);
  });

  it('records the session in session-map', async () => {
    await evaluateHook(makePayload({ session_id: 'fresh-123', cwd: '/tmp/proj-x' }));
    const entry = await getSessionEntry('fresh-123');
    expect(entry).not.toBeNull();
    expect(entry?.lastCwd).toBe('/tmp/proj-x');
  });

  it('increments per-session turn counter across calls', async () => {
    const payload = makePayload({ session_id: 'turn-test' });
    await evaluateHook(payload);
    const out = await evaluateHook(payload);
    // Turn counter is surfaced in the meta stamp as `t<n>`.
    expect(out.systemMessage).toMatch(/t2/);
  });

  it('passthrough on a low-pressure continuation produces a minimal stamp', async () => {
    const output = await evaluateHook(makePayload());
    // No body, just the meta stamp — no glyph like ◈ or ⇌ or ⟳.
    expect(output.systemMessage).not.toMatch(/◈|⇌|⟳|∎→|▞▞▞/);
  });

  it('detects memory intent and returns a saved-memory message', async () => {
    const output = await evaluateHook(makePayload({
      prompt: 'remember that the AWS profile is set via AWS_PROFILE=demo before every deploy',
      session_id: 'memory-intent-session',
    }));
    expect(output.systemMessage).toMatch(/memory saved/);
    expect(output.systemMessage).toMatch(/◈/);
  });

  it('falls through to recall instead of crashing on a snapshot_name collision', async () => {
    const prompt = 'remember that the staging deploy script lives at scripts/deploy-staging.sh';
    // First capture succeeds normally.
    const first = await evaluateHook(makePayload({ prompt, session_id: 'collision-1' }));
    expect(first.systemMessage).toMatch(/memory saved/);

    // Second call with the same prompt produces the same snapshotName, so
    // createMemory's INSERT collides on the UNIQUE(snapshot_name) constraint.
    const second = await evaluateHook(makePayload({ prompt, session_id: 'collision-2' }));
    expect(second.systemMessage).not.toMatch(/johnny crashed/);
    // Falls through to heuristics/recall — not a second "memory saved".
    expect(second.systemMessage).not.toMatch(/memory saved/);
  });

  it('does not capture a memory for a prompt that merely mentions a .md filename', async () => {
    const output = await evaluateHook(makePayload({
      prompt: 'what does can-you-please-pull-vivid-globe.md mean?',
      session_id: 'md-mention-session',
    }));
    expect(output.systemMessage ?? '').not.toMatch(/memory saved/);
    expect(output.systemMessage ?? '').not.toMatch(/◈/);
  });

  it('captures the full prompt (not the bare filename) for genuine doc-intent with a .md mention', async () => {
    const output = await evaluateHook(makePayload({
      prompt: 'write a plan for fixing the bug described in can-you-please-pull-vivid-globe.md',
      session_id: 'doc-intent-md-session',
    }));
    expect(output.systemMessage).toMatch(/memory saved/);
    // snapshotName must not be the collapsed bare filename slug.
    const match = output.systemMessage!.match(/· ([a-z0-9-]+)\n/);
    expect(match?.[1]).not.toBe('can-you-please-pull-vivid-globe');
  });

  it('detects praise and adds a clap-back line', async () => {
    // Run a first turn so session exists, then praise on the second.
    await evaluateHook(makePayload({ session_id: 'praise-1' }));
    const output = await evaluateHook(makePayload({
      session_id: 'praise-1',
      prompt: 'thanks, that worked perfectly',
    }));
    // Clap-back uses the ◎ glyph.
    expect(output.systemMessage).toMatch(/◎/);
  });

it('routes a topic-switch prompt to a matching memory', async () => {
    const mem = await addMemory(
      'roku-auth-token',
      'Roku auth token refresh',
      'debugged auth token refresh in roku-auth with 401 handling',
      'transcript',
      '/tmp/roku-auth',
      800,
      ['roku', 'auth', 'token', 'refresh'],
      1,
    );
    // Pre-compute mock embedding so rankBySimilarity can score this memory.
    await embedMemory(mem);
    // Prior session was in a different CWD so cwdChanged fires the context boost.
    await setActiveSession('sw-session', '/tmp/other-project', null, 'passthrough');
    const output = await evaluateHook(makePayload({
      session_id: 'sw-session',
      cwd: '/tmp/roku-auth',
      prompt: 'roku auth token refresh is broken again, 401 keeps firing',
    }));
    // Recall fires (⇌ recommend or ◇ offer depending on composite score in mock mode).
    expect(output.systemMessage).toMatch(/⇌|◇/);
    // Side effect: recall action calls touchMemory → retrievalCount bumps.
    const { getMemoryById } = await import('../../src/store/memory.js');
    const fresh = await getMemoryById(mem.id);
    expect(fresh?.retrievalCount).toBeGreaterThan(0);
  });

  it('returns a crash fallback message on internal errors without throwing', async () => {
    // Force an error: point at a transcript path that doesn't exist. The
    // pipeline tolerates this (analyzeSession catches internally), so the
    // invariant we actually want is: evaluateHook never throws.
    const output = await evaluateHook(makePayload({
      transcript_path: '/nonexistent/path/xyz.jsonl',
      session_id: 'crash-test',
    }));
    // Whether it produces a normal stamp or the crash fallback, it MUST return.
    expect(typeof output.systemMessage).toBe('string');
  });

  it('first-fire on a fresh session does not error', async () => {
    // Regression guard: the isFirstFire banner write path used to blow up in
    // non-TTY test environments. It must stay silent and succeed.
    const output = await evaluateHook(makePayload({ session_id: 'first-fire-test' }));
    expect(output).toBeDefined();
  });

  it('emits a bootstrap landscape hint on the first hook fire when project has memories', async () => {
    await addMemory(
      'cdk-deploy-refinement',
      'CDK deploy refinement',
      'wake-portal CDK deploy steps',
      'transcript',
      '/tmp/wake-portal',
      400,
      ['cdk', 'deploy', 'aws'],
      1,
    );
    const output = await evaluateHook(makePayload({
      session_id: 'bootstrap-test',
      cwd: '/tmp/wake-portal',
      prompt: 'what was I working on',
    }));
    expect(output.additionalContext).toBeTruthy();
    expect(output.additionalContext).toMatch(/wake-portal/);
    expect(output.additionalContext).toMatch(/johnny_recall/);
  });

  it('does not emit bootstrap on a second hook fire of the same session', async () => {
    await addMemory(
      'cdk-deploy-refinement',
      'CDK deploy refinement',
      'wake-portal CDK deploy steps',
      'transcript',
      '/tmp/wake-portal',
      400,
      ['cdk', 'deploy', 'aws'],
      1,
    );
    const payload = makePayload({ session_id: 'bootstrap-once', cwd: '/tmp/wake-portal' });
    await evaluateHook(payload);
    const second = await evaluateHook(payload);
    expect(second.additionalContext ?? '').not.toMatch(/new session in wake-portal/);
  });

  it('skips bootstrap when the project has no memories', async () => {
    const output = await evaluateHook(makePayload({
      session_id: 'bootstrap-empty',
      cwd: '/tmp/empty-project',
    }));
    expect(output.additionalContext ?? '').not.toMatch(/new session in/);
  });
});

import { gateHardSwitch } from '../../src/cli/evaluate.js';
describe('gateHardSwitch (hard_switch rewrites the live transcript)', () => {
  it('demotes hard_switch to recommend_memory unless explicitly allowed', () => {
    expect(gateHardSwitch('hard_switch', {})).toBe('recommend_memory');
    expect(gateHardSwitch('hard_switch', { allowHardSwitch: false })).toBe('recommend_memory');
    expect(gateHardSwitch('hard_switch', { allowHardSwitch: true })).toBe('hard_switch');
  });
  it('leaves every other action untouched', () => {
    for (const a of ['offer', 'recommend_memory', 'passthrough', 'suggest_memories', 'snapshot_passthrough'] as const) {
      expect(gateHardSwitch(a, {})).toBe(a);
    }
  });
});
