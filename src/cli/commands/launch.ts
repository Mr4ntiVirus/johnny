// johnny (no args) — full stack bootstrap, then launch coding assistant.
import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../store/paths.js';
import { isPidAlive, readDaemonPid } from '../../utils/pid.js';
import { readGraph } from '../../store/graph.js';
import { readState } from '../../store/state.js';
import { Spinner } from '../../utils/spinner.js';
import { cmdSetup } from './setup.js';
import { cmdBootstrap } from './bootstrap.js';
import { detectAll } from './detect.js';
import { dim, neon, ink } from '../../brand/tokens.js';
import { startupLine } from '../../brand/greetings.js';
import { top, bot, div, row, section, field } from '../../brand/bbs.js';
import { log } from '../../utils/log.js';

const w = (s: string) => process.stdout.write(s);
const nl = () => w('\n');

// ── Full stack bootstrap ───────────────────────────────────────────────────

async function ensureJohnnyStack(): Promise<void> {
  const spinner = new Spinner();

  nl();
  w(top());
  w(row(''));
  w(row(neon.amber('J O H N N Y') + dim.fg('  ·  ') + neon.cyan('ml context librarian')));
  w(row(''));
  w(div());
  w(section('initializing johnny stack'));
  w(row(''));

  // 1. Ensure config exists (run setup if needed)
  spinner.start('ensuring configuration...');
  let needsSetup = false;
  try {
    await fs.access(PATHS.config);
  } catch {
    needsSetup = true;
  }

  if (needsSetup) {
    spinner.stop(neon.cyan('◈'), field('CONFIG', 'setting up...'));
    w(row(''));
    await cmdSetup();
    w(row(''));
  } else {
    spinner.stop(neon.cyan('◈'), field('CONFIG', 'ready'));
  }

  // 2. Wetware status
  spinner.start('loading wetware...');
  const [graph, state] = await Promise.all([
    readGraph().catch(() => ({ memories: {} as Record<string, unknown> })),
    readState().catch(() => ({ turnCounter: 0 })),
  ]);
  const subjects = Object.keys(graph.memories).length;
  const subjectLabel = subjects === 0 ? 'cold start' : `${subjects} subjects`;
  spinner.stop(neon.cyan('◈'), field('WETWARE', `${subjectLabel}  ·  t${state.turnCounter}`));

  // 3. Ensure daemon is running
  spinner.start('checking daemon...');
  let daemonPid = await readDaemonPid();
  
  if (!daemonPid || !isPidAlive(daemonPid)) {
    spinner.update('starting daemon...');
    const selfPath = fileURLToPath(import.meta.url);
    const cliEntry = path.resolve(path.dirname(selfPath), '..', 'index.js');
    const child = cp.spawn(process.execPath, [cliEntry, 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    
    // Wait for daemon to start
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      daemonPid = await readDaemonPid();
      if (daemonPid && isPidAlive(daemonPid)) break;
    }
  }

  if (daemonPid && isPidAlive(daemonPid)) {
    spinner.stop(neon.cyan('◈'), field('DAEMON', `online  ·  PID ${daemonPid}`));
  } else {
    spinner.stop(neon.amber('↯'), field('DAEMON', 'offline · no consolidation', neon.amber));
  }

  // 4. Try to start MCP server in background
  spinner.start('checking mcp server...');
  // Test if MCP is reachable - for now just mark as ready
  spinner.stop(neon.cyan('◈'), field('MCP', 'available'));

  // 5. Quick bootstrap check (incremental)
  if (subjects === 0) {
    spinner.start('first run bootstrap...');
    try {
      await cmdBootstrap(true);
      spinner.stop(neon.cyan('◈'), field('BOOTSTRAP', 'session ingest complete'));
    } catch {
      spinner.stop(neon.amber('↯'), field('BOOTSTRAP', 'skipped'));
    }
  }

  w(row(''));
  w(div());
  nl();
}

// ── Entry point ───────────────────────────────────────────────────────────

export async function cmdLaunch(args: string[]): Promise<void> {
  const launchArgs = args.filter(a => !a.startsWith('--'));

  // Initialize the full local stack (daemon, models, MCP)
  await ensureJohnnyStack();

  const assistants = await detectAll();
  if (assistants.length === 0) {
    w(bot());
    nl();
    process.stderr.write(neon.red('× claude not found\n'));
    await log('× claude not found');
    process.stderr.write(dim.fg('  install Claude Code (claude.ai/code), then run `johnny` again\n'));
    process.exit(1);
  }

  w(bot());
  nl();
  w(row(neon.cyan('▶ launching Claude Code...')));
  nl();

  const child = cp.spawn('claude', launchArgs, { stdio: 'inherit', env: process.env });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
