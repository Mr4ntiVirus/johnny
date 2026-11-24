// Regression coverage for the watcher.ts fix: background post-turn
// maintenance must run as a `JOHNNY_LOCAL_STORE=1 johnny post-turn` subprocess
// (mirroring the real installed hook) rather than an in-process import that
// silently sent every DB call to Postgres over the (often-unreachable)
// Pooler relay — see the comment above runPostTurnHook in watcher.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Deterministic fake: emits stderr (if any) then 'close' only once end() is
// called, both queued as microtasks so ordering never races real stream
// timing (this replaces an earlier version of this test that used a real
// PassThrough and was flaky on 'finish' timing).
function fakeChild(exitCode: number | null, stderrText = '') {
  const child: any = new EventEmitter();
  const written: Buffer[] = [];
  child.stdin = {
    write(chunk: any, cb?: (err?: Error) => void) {
      written.push(Buffer.from(chunk));
      if (cb) queueMicrotask(() => cb());
      return true;
    },
    end() {
      queueMicrotask(() => {
        if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
        queueMicrotask(() => child.emit('close', exitCode));
      });
    },
  };
  child.stderr = new EventEmitter();
  child.__written = () => Buffer.concat(written).toString();
  return child;
}

describe('daemon/watcher — runPostTurnHook', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the CLI post-turn subcommand as a child process', async () => {
    const child = fakeChild(0);
    spawnMock.mockReturnValue(child);

    const { runPostTurnHook } = await import('../../src/daemon/watcher.js');
    await runPostTurnHook('/home/user/.claude/projects/proj/abc-123.jsonl');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, args] = spawnMock.mock.calls[0];
    expect(execPath).toBe(process.execPath);
    expect(args[1]).toBe('post-turn');
  });

  it('writes {transcript_path, session_id} derived from the filename on stdin', async () => {
    const child = fakeChild(0);
    spawnMock.mockReturnValue(child);

    const { runPostTurnHook } = await import('../../src/daemon/watcher.js');
    await runPostTurnHook('/home/user/.claude/projects/proj/abc-123.jsonl');

    const payload = JSON.parse(child.__written());
    expect(payload.transcript_path).toBe('/home/user/.claude/projects/proj/abc-123.jsonl');
    expect(payload.session_id).toBe('abc-123');
  });

  it('resolves on a clean exit', async () => {
    const child = fakeChild(0);
    spawnMock.mockReturnValue(child);

    const { runPostTurnHook } = await import('../../src/daemon/watcher.js');
    await expect(runPostTurnHook('/tmp/proj/xyz.jsonl')).resolves.toBeUndefined();
  });

  it('rejects when the subprocess exits non-zero with stderr output', async () => {
    const child = fakeChild(1, 'boom');
    spawnMock.mockReturnValue(child);

    const { runPostTurnHook } = await import('../../src/daemon/watcher.js');
    await expect(runPostTurnHook('/tmp/proj/xyz.jsonl')).rejects.toThrow(/boom/);
  });
});
