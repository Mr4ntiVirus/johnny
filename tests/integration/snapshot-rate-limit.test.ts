// Integration test for the post-turn snapshot rate limit. Without this gate,
// every PostToolUse fires snapshot when pressure stays above 80% — the
// "6 snapshots in 7 minutes" pattern observed in the live log. The fix:
// per-session cooldown (default 60s).
//
// We mock the snapshot action so we don't need a full CMV session structure
// in tests. The contract being verified is "post-turn calls snapshot() at
// most once per cooldown window per session."

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { setLastSnapshotAt } from '../../src/store/db/sessions.js';

// Mock both action paths so we can isolate the rate-limit gate. trim is mocked
// as a no-op so it doesn't actually shrink the fixture file (which would drop
// pressure and prevent the snapshot path from being reached).
const snapshotSpy = vi.fn(async () => ({
  output: {},
  snapshotName: 'mocked-snapshot' as string | null,
}));
const trimSpy = vi.fn(async () => ({}));
vi.mock('../../src/actions/snapshot.js', () => ({
  snapshot: snapshotSpy,
}));
vi.mock('../../src/actions/trim.js', () => ({
  trim: trimSpy,
}));

// Imported AFTER vi.mock so post-turn picks up the mock.
const { runPostTurnForPath } = await import('../../src/cli/post-turn.js');

function buildBigJsonl(targetBytes: number): string {
  const lines: string[] = [];
  let total = 0;
  let i = 0;
  const sysLine = JSON.stringify({
    type: 'system',
    cwd: '/tmp/rl-test',
    sessionId: 'rl-test',
    timestamp: '2026-05-04T00:00:00.000Z',
  });
  lines.push(sysLine);
  total += sysLine.length + 1;
  while (total < targetBytes) {
    const userText = `q${i} ` + 'lorem ipsum dolor sit amet '.repeat(40);
    const asstText = `a${i} ` + 'consectetur adipiscing elit '.repeat(50);
    const toolText = 'output: ' + 'captured stdout text '.repeat(60);
    const u = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } });
    const a = JSON.stringify({
      type: 'assistant',
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: asstText },
          { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/x/${i}.ts` } },
        ],
      },
    });
    const t = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: toolText }] },
    });
    for (const l of [u, a, t]) { lines.push(l); total += l.length + 1; }
    i++;
  }
  return lines.join('\n') + '\n';
}

describe('integration: post-turn snapshot rate limit', () => {
  useTestDb();

  let tmpHome: string;
  let tmpDir: string;
  let bigJsonl: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-rl-'));
    bigJsonl = path.join(tmpDir, 'big.jsonl');
    fs.writeFileSync(bigJsonl, buildBigJsonl(800_000));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-rl-home-'));
    process.env.HOME = tmpHome;
    snapshotSpy.mockClear();
    trimSpy.mockClear();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('first call at high pressure invokes snapshot', async () => {
    await runPostTurnForPath(bigJsonl, 'rl-sess-1', '/tmp/x');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('second call within cooldown does NOT invoke snapshot again', async () => {
    // Simulate a snapshot that just happened.
    await setLastSnapshotAt('rl-sess-2', new Date());
    await runPostTurnForPath(bigJsonl, 'rl-sess-2', '/tmp/x');
    expect(snapshotSpy).toHaveBeenCalledTimes(0);
  });

  it('call after cooldown window DOES invoke snapshot', async () => {
    // Simulate a snapshot that happened 2 minutes ago (well past 60s cooldown).
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
    await setLastSnapshotAt('rl-sess-3', twoMinutesAgo);
    await runPostTurnForPath(bigJsonl, 'rl-sess-3', '/tmp/x');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('rate limit is per-session — different sessions are independent', async () => {
    // Session A just snapshotted.
    await setLastSnapshotAt('rl-sess-A', new Date());
    // Session B has never snapshotted.
    await runPostTurnForPath(bigJsonl, 'rl-sess-B', '/tmp/x');
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('rapid succession: 5 post-turn calls produce exactly 1 snapshot call', async () => {
    // Worst case: PostToolUse fires 5 times in a row for tool calls.
    // Without rate limit, this would invoke snapshot() 5 times.
    for (let i = 0; i < 5; i++) {
      await runPostTurnForPath(bigJsonl, 'rl-burst', '/tmp/x');
    }
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  // ── Trim from post-turn (the regression the user just flagged) ────────────

  it('trim fires from post-turn at high pressure (the agentic-stretch fix)', async () => {
    await runPostTurnForPath(bigJsonl, 'rl-trim-1', '/tmp/x');
    expect(trimSpy).toHaveBeenCalledTimes(1);
  });

  it('trim is rate-limited per session (cooldown)', async () => {
    // Simulate a recent trim. Next post-turn should suppress it.
    const { setLastTrimAt } = await import('../../src/store/db/sessions.js');
    await setLastTrimAt('rl-trim-2', new Date());
    await runPostTurnForPath(bigJsonl, 'rl-trim-2', '/tmp/x');
    expect(trimSpy).toHaveBeenCalledTimes(0);
  });

  it('trim fires after cooldown elapsed', async () => {
    const { setLastTrimAt } = await import('../../src/store/db/sessions.js');
    await setLastTrimAt('rl-trim-3', new Date(Date.now() - 60_000));
    await runPostTurnForPath(bigJsonl, 'rl-trim-3', '/tmp/x');
    expect(trimSpy).toHaveBeenCalledTimes(1);
  });

  it('5 rapid post-turn calls produce exactly 1 trim call (rate limited)', async () => {
    for (let i = 0; i < 5; i++) {
      await runPostTurnForPath(bigJsonl, 'rl-trim-burst', '/tmp/x');
    }
    expect(trimSpy).toHaveBeenCalledTimes(1);
  });

  // ── The cursor-reset regression (inverted) ───────────────────────────────
  // Historically trim zeroed the line cursor because a shrunken JSONL left the
  // cursor past EOF and snapshots stalled forever. That reset then made every
  // snapshot re-capture the entire post-trim file (83% of all stored chunks
  // were duplicates). The delta is now content-addressed (anchor uuid + global
  // ledger, see src/actions/snapshot-delta.ts): trim must leave the cursor
  // alone, and a cursor past EOF cannot stall because it is never trusted once
  // an anchor exists (covered in tests/actions/snapshot-delta.test.ts).
  it('trim does NOT reset the snapshot delta cursor', async () => {
    const { setLastSnapshotLine, getLastSnapshotLine } = await import('../../src/store/db/sessions.js');

    await setLastSnapshotLine('rl-cursor', 2000);
    expect(await getLastSnapshotLine('rl-cursor')).toBe(2000);

    await runPostTurnForPath(bigJsonl, 'rl-cursor', '/tmp/x');

    expect(trimSpy).toHaveBeenCalledTimes(1);
    expect(await getLastSnapshotLine('rl-cursor')).toBe(2000); // untouched by trim
  });
});
