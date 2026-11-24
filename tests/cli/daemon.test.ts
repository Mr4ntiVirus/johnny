// Coverage for daemon.ts's pure start/stop/restart core (extracted from
// cmdDaemon so the doctor TUI's 'r' restart shortcut can drive the same
// logic without raw stdout writes or process.exit — see the comment on
// stopDaemonCore/startDaemonCore/restartDaemonCore in cli/commands/daemon.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readDaemonPidMock = vi.fn();
const isPidAliveMock = vi.fn();
vi.mock('../../src/utils/pid.js', () => ({
  readDaemonPid: (...args: unknown[]) => readDaemonPidMock(...args),
  isPidAlive: (...args: unknown[]) => isPidAliveMock(...args),
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const unlinkMock = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  unlink: (...args: unknown[]) => unlinkMock(...args),
}));

function fakeChild() {
  return { unref: vi.fn() };
}

describe('cli/commands/daemon — startDaemonCore', () => {
  beforeEach(() => {
    readDaemonPidMock.mockReset();
    isPidAliveMock.mockReset();
    spawnMock.mockReset();
    unlinkMock.mockClear();
    spawnMock.mockReturnValue(fakeChild());
  });

  it('returns already-on without spawning when a live pid exists', async () => {
    readDaemonPidMock.mockResolvedValue(42);
    isPidAliveMock.mockReturnValue(true);

    const { startDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const result = await startDaemonCore();

    expect(result).toEqual({ status: 'already-on', pid: 42 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns and returns started once the pid comes alive, polling past a slow first check', async () => {
    readDaemonPidMock
      .mockResolvedValueOnce(null) // no existing daemon
      .mockResolvedValueOnce(null) // first poll: not up yet
      .mockResolvedValueOnce(99);  // second poll: up
    isPidAliveMock.mockReturnValue(true);

    vi.useFakeTimers();
    const { startDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const p = startDaemonCore();
    await vi.advanceTimersByTimeAsync(500);
    const result = await p;
    vi.useRealTimers();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'started', pid: 99 });
  });

  it('returns failed when the pid never comes alive after the full poll budget', async () => {
    readDaemonPidMock.mockResolvedValue(null);
    isPidAliveMock.mockReturnValue(false);

    vi.useFakeTimers();
    const { startDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const p = startDaemonCore();
    await vi.advanceTimersByTimeAsync(2100); // past the 10 × 200ms poll budget
    const result = await p;
    vi.useRealTimers();

    expect(result).toEqual({ status: 'failed' });
  });
});

describe('cli/commands/daemon — stopDaemonCore', () => {
  beforeEach(() => {
    readDaemonPidMock.mockReset();
    isPidAliveMock.mockReset();
    unlinkMock.mockClear();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns already-dark when no pid file exists', async () => {
    readDaemonPidMock.mockResolvedValue(null);

    const { stopDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const result = await stopDaemonCore();

    expect(result).toEqual({ status: 'already-dark' });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('cleans up a stale pid file and returns already-dark when the pid is not alive', async () => {
    readDaemonPidMock.mockResolvedValue(7);
    isPidAliveMock.mockReturnValue(false);

    const { stopDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const result = await stopDaemonCore();

    expect(result).toEqual({ status: 'already-dark' });
    expect(unlinkMock).toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and reports stopped once the process dies', async () => {
    readDaemonPidMock.mockResolvedValue(55);
    // Alive for the initial check and first couple of polls, then dead.
    let calls = 0;
    isPidAliveMock.mockImplementation(() => { calls += 1; return calls < 3; });

    vi.useFakeTimers();
    const { stopDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const p = stopDaemonCore();
    await vi.advanceTimersByTimeAsync(300);
    const result = await p;
    vi.useRealTimers();

    expect(process.kill).toHaveBeenCalledWith(55, 'SIGTERM');
    expect(result).toEqual({ status: 'stopped', pid: 55 });
  });

  it('escalates to SIGKILL and reports force-killed when the process never dies', async () => {
    readDaemonPidMock.mockResolvedValue(66);
    isPidAliveMock.mockReturnValue(true); // never dies

    vi.useFakeTimers();
    const { stopDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const p = stopDaemonCore();
    await vi.advanceTimersByTimeAsync(3100); // past the 30 × 100ms poll budget
    const result = await p;
    vi.useRealTimers();

    expect(process.kill).toHaveBeenCalledWith(66, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(66, 'SIGKILL');
    expect(result).toEqual({ status: 'force-killed', pid: 66 });
  });
});

describe('cli/commands/daemon — restartDaemonCore', () => {
  beforeEach(() => {
    readDaemonPidMock.mockReset();
    isPidAliveMock.mockReset();
    spawnMock.mockReset();
    unlinkMock.mockClear();
    spawnMock.mockReturnValue(fakeChild());
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the old daemon and starts a new one, returning both pids', async () => {
    // stop: pid 10 alive on the initial check, dead on its first poll.
    // start: no existing pid, then pid 20 alive once spawned. Keyed by pid
    // (not a raw call counter) since both phases call isPidAlive in sequence
    // within the same restartDaemonCore() run.
    const aliveCallsByPid = new Map<number, number>();
    readDaemonPidMock
      .mockResolvedValueOnce(10)  // stopDaemonCore's readDaemonPid
      .mockResolvedValueOnce(null) // startDaemonCore's "existing" check
      .mockResolvedValueOnce(20);  // startDaemonCore's post-spawn read
    isPidAliveMock.mockImplementation((pid: number) => {
      const n = (aliveCallsByPid.get(pid) ?? 0) + 1;
      aliveCallsByPid.set(pid, n);
      if (pid === 10) return n < 2; // dies after the first poll
      return true; // pid 20 (the newly-spawned daemon) is alive
    });

    vi.useFakeTimers();
    const { restartDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const p = restartDaemonCore();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;
    vi.useRealTimers();

    expect(result).toEqual({ status: 'restarted', oldPid: 10, newPid: 20 });
  });

  it('reports failed with the old pid when the daemon was already dark and restart fails to start', async () => {
    readDaemonPidMock
      .mockResolvedValueOnce(null) // stop: already dark
      .mockResolvedValueOnce(null); // start: no existing daemon
    isPidAliveMock.mockReturnValue(false); // start never comes alive

    const { restartDaemonCore } = await import('../../src/cli/commands/daemon.js');
    const result = await restartDaemonCore();

    expect(result).toEqual({ status: 'failed', oldPid: null });
  });
});

describe('cli/commands/daemon — cmdDaemon restart', () => {
  // The `johnny daemon restart` CLI subcommand — what docker/terminal-server/
  // server.js's restartDaemon() actually spawns (`spawn('johnny', ['daemon',
  // 'restart'])`), reading its stdout/stderr and exit code to build the
  // browser dashboard's restart-result frame. Correctness here (stdout on
  // success, stderr + exit 1 on failure) is load-bearing for that caller.
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readDaemonPidMock.mockReset();
    isPidAliveMock.mockReset();
    spawnMock.mockReset();
    unlinkMock.mockClear();
    spawnMock.mockReturnValue(fakeChild());
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // process.exit(1) must not actually kill the test worker.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // restartDaemonCore's stop phase sends a real SIGTERM otherwise — there's
    // no live process behind these fake pids.
    vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the new PID to stdout on a successful restart', async () => {
    // stop: pid 10, dies after one poll. start: no existing pid, then pid 20 alive.
    const aliveCallsByPid = new Map<number, number>();
    readDaemonPidMock
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(20);
    isPidAliveMock.mockImplementation((pid: number) => {
      const n = (aliveCallsByPid.get(pid) ?? 0) + 1;
      aliveCallsByPid.set(pid, n);
      if (pid === 10) return n < 2;
      return true;
    });

    vi.useFakeTimers();
    const { cmdDaemon } = await import('../../src/cli/commands/daemon.js');
    const p = cmdDaemon(['restart']);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    vi.useRealTimers();

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('daemon restarted · PID 20'));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('writes to stderr and exits 1 when the restart fails to bring the daemon back up', async () => {
    readDaemonPidMock.mockResolvedValue(null); // stop: already dark; start: no existing pid
    isPidAliveMock.mockReturnValue(false); // start never comes alive

    const { cmdDaemon } = await import('../../src/cli/commands/daemon.js');
    await cmdDaemon(['restart']);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('daemon restart failed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
