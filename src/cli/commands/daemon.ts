import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PATHS } from '../../store/paths.js';
import { isPidAlive, readDaemonPid } from '../../utils/pid.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { neon, ink, dim } from '../../brand/tokens.js';
import { startupLine, shutdownLine } from '../../brand/greetings.js';
import { log } from '../../utils/log.js';

// ── Core start/stop, no I/O side effects ────────────────────────────────────
// Extracted so callers that can't write raw stdout/exit the process — e.g.
// the doctor TUI's restart shortcut, which needs structured results to
// render instead — can drive the same logic cmdDaemon uses.

export type StopResult =
  | { status: 'already-dark' }
  | { status: 'stopped'; pid: number }
  | { status: 'force-killed'; pid: number };

export async function stopDaemonCore(): Promise<StopResult> {
  const pid = await readDaemonPid();
  if (!pid) return { status: 'already-dark' };
  if (!isPidAlive(pid)) {
    try { await fs.unlink(PATHS.daemonPid); } catch { /* ok */ }
    return { status: 'already-dark' };
  }

  process.kill(pid, 'SIGTERM');

  // Wait up to 3s for clean exit, then escalate to SIGKILL
  let dead = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isPidAlive(pid)) { dead = true; break; }
  }
  if (!dead) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    await log(`daemon: SIGKILL sent · PID ${pid}`);
    return { status: 'force-killed', pid };
  }
  await log(`daemon: ${shutdownLine()}`);
  return { status: 'stopped', pid };
}

export type StartResult =
  | { status: 'already-on'; pid: number }
  | { status: 'started'; pid: number }
  | { status: 'failed' };

export async function startDaemonCore(): Promise<StartResult> {
  const existing = await readDaemonPid();
  if (existing && isPidAlive(existing)) {
    return { status: 'already-on', pid: existing };
  }

  const selfPath = fileURLToPath(import.meta.url);
  const cliEntry = path.resolve(path.dirname(selfPath), '..', 'index.js');

  const child = spawn(process.execPath, [cliEntry, 'daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll instead of a single fixed-delay check: a single 500ms check
  // occasionally reported 'failed' for a daemon that came up fine ~200-300ms
  // later (observed directly restarting the daemon while testing the
  // dashboard's "restart daemon" button — right after a SIGTERM-triggered
  // stop, PID-file write + subsystem boot can run a bit past 500ms). 10 ×
  // 200ms mirrors stopDaemonCore's own poll-loop shape below, capped at 2s
  // total so a genuinely dead spawn still reports 'failed' promptly.
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 200));
    const pid = await readDaemonPid();
    if (pid && isPidAlive(pid)) {
      await log(`daemon: ${startupLine()} · PID ${pid}`);
      return { status: 'started', pid };
    }
  }
  await log('daemon: start failed');
  return { status: 'failed' };
}

export type RestartResult =
  | { status: 'restarted'; oldPid: number | null; newPid: number }
  | { status: 'failed'; oldPid: number | null };

// stop (best-effort — a dark daemon is not an error) then start.
export async function restartDaemonCore(): Promise<RestartResult> {
  const stopResult = await stopDaemonCore();
  const oldPid = 'pid' in stopResult ? stopResult.pid : null;
  const startResult = await startDaemonCore();
  if (startResult.status === 'started' || startResult.status === 'already-on') {
    return { status: 'restarted', oldPid, newPid: startResult.pid };
  }
  return { status: 'failed', oldPid };
}

export async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';

  switch (sub) {
    case 'start': {
      const result = await startDaemonCore();
      if (result.status === 'already-on') {
        process.stderr.write(neon.red(`× already on · PID ${result.pid}\n`));
        await log(`daemon: already on · PID ${result.pid}`);
        process.exit(1);
      } else if (result.status === 'started') {
        process.stdout.write(neon.cyan(`◈ ${startupLine()} · PID ${result.pid}\n`));
      } else {
        process.stderr.write(neon.red('× start failed · check ~/.johnny/johnny.log\n'));
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      const result = await stopDaemonCore();
      if (result.status === 'already-dark') {
        process.stdout.write(ink.fg('  already dark\n'));
      } else if (result.status === 'force-killed') {
        process.stderr.write(neon.amber(`⚠ SIGKILL sent · PID ${result.pid} wouldn't die cleanly\n`));
      } else {
        process.stdout.write(neon.magenta(`∎ ${shutdownLine()}\n`));
      }
      break;
    }

    case 'restart': {
      const result = await restartDaemonCore();
      if (result.status === 'restarted') {
        process.stdout.write(neon.cyan(`◈ daemon restarted · PID ${result.newPid}\n`));
      } else {
        process.stderr.write(neon.red('× daemon restart failed · check ~/.johnny/johnny.log\n'));
        process.exit(1);
      }
      break;
    }

    case 'status':
    default: {
      const pid = await readDaemonPid();
      if (!pid || !isPidAlive(pid)) {
        process.stdout.write(ink.fg('  daemon: dark\n'));
      } else {
        process.stdout.write(neon.cyan(`  daemon: on · PID ${pid}\n`));
      }
      break;
    }
  }
}
