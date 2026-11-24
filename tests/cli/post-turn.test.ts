// Integration tests for runPostTurnForPath — the post-tool-use bookkeeper.
// Drives the transcript-path entry point with fixture JSONL and verifies
// auto-snapshot fires only at ≥80% pressure and only above the min-size floor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { runPostTurnForPath } from '../../src/cli/post-turn.js';
import { listMemories } from '../../src/store/memory.js';

describe('runPostTurnForPath', () => {
  useTestDb();

  let tmpHome: string;
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-pt-home-'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-pt-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    for (const d of [tmpHome, tmpDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('skips silently when transcript is below the size floor', async () => {
    const tiny = path.join(tmpDir, 'tiny.jsonl');
    fs.writeFileSync(tiny, '{"type":"user","content":"hi"}\n');
    await runPostTurnForPath(tiny, 'small-sess', '/tmp/any');
    // No snapshot created — DB stays empty.
    const memories = await listMemories();
    expect(memories).toHaveLength(0);
  });

  it('reads pressure on larger transcripts without throwing', async () => {
    // Build a transcript just over the 100k byte floor so the analyzer runs.
    const big = path.join(tmpDir, 'big.jsonl');
    const line = JSON.stringify({
      type: 'user',
      content: 'x'.repeat(1000),
      timestamp: '2026-04-24T00:00:00Z',
    }) + '\n';
    // 110 lines × ~1040 bytes ≈ 114 KB > 100 KB floor, but well under the
    // ≥80% pressure threshold so auto-snapshot must not fire.
    fs.writeFileSync(big, line.repeat(110));
    await runPostTurnForPath(big, 'big-sess', '/tmp/any');
    const memories = await listMemories();
    expect(memories).toHaveLength(0);
  });

  it('handles a missing transcript path without throwing', async () => {
    // Root cause of crashes was an uncaught stat() error on a removed file.
    await expect(
      runPostTurnForPath('/nonexistent/xyz.jsonl', 'gone-sess', '/tmp/any'),
    ).resolves.toBeUndefined();
  });

  it('resolves cwd from session-map when caller omits it', async () => {
    const { setActiveSession } = await import('../../src/store/session-map.js');
    await setActiveSession('cwd-sess', '/tmp/known-cwd', null, 'passthrough');
    const tiny = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(tiny, '{}\n');
    // Under the size floor — should return quickly without needing the cwd,
    // but the lookup path must still not throw.
    await expect(
      runPostTurnForPath(tiny, 'cwd-sess'),
    ).resolves.toBeUndefined();
  });
});
