// Johnny Neuromorphic daemon
// Background process for model warming, session watching, and memory management.
// Everything runs locally: rank refresh, embedding backfill and sleep consolidation
// (latent edge discovery + edge pruning) use the local SQLite store and local Ollama.
// Run in foreground: `johnny daemon`
// Managed via: `johnny daemon start` / `johnny daemon stop` / `johnny daemon status`
import * as fs from 'node:fs/promises';
import { PATHS } from '../store/paths.js';
import { log } from '../utils/log.js';
import { isBypassed } from '../utils/bypass.js';
import { neon } from '../brand/tokens.js';
import { startupLine, shutdownLine } from '../brand/greetings.js';
import { startModelWarmer, stopModelWarmer } from './model-warmer.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { startIdleTrigger, stopIdleTrigger } from './idle-trigger.js';
import { startEmbedBackfill, stopEmbedBackfill } from './embed-backfill.js';

async function writePid(): Promise<void> {
  await fs.writeFile(PATHS.daemonPid, String(process.pid), 'utf-8');
}

async function clearPid(): Promise<void> {
  try { await fs.unlink(PATHS.daemonPid); } catch { /* ok if already gone */ }
}

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const farewell = shutdownLine();
  await log(`daemon: ${farewell} (${signal})`);
  stopModelWarmer();
  stopWatcher();
  stopIdleTrigger();
  stopEmbedBackfill();
  await clearPid();
  // Foreground mode: farewell to stderr. Detached mode: stderr is closed, log only.
  process.stderr.write(neon.magenta(`∎ ${farewell}\n`));
  process.exit(0);
}

export async function runDaemon(): Promise<void> {
  // Mark this process as the daemon (read by log and watcher code).
  process.env.JOHNNY_DAEMON_PROCESS = '1';

  if (isBypassed()) {
    process.stderr.write(neon.red('× bypass active · staying dark\n'));
    await log('daemon: bypass active · staying dark');
    process.exit(1);
  }

  // Check for existing daemon
  try {
    const pidStr = await fs.readFile(PATHS.daemonPid, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // 0 = existence check, throws if not alive
        process.stderr.write(neon.red(`× already running · PID ${pid}\n`));
        await log(`× already running · PID ${pid}`);
        process.exit(1);
      } catch {
        // PID is stale — proceed
      }
    }
  } catch { /* no PID file — first run */ }

  await writePid();

  const greeting = startupLine();
  await log(`daemon: ${greeting} (PID ${process.pid})`);
  // Written to stderr — visible in foreground mode; silently ignored when detached.
  process.stderr.write(neon.cyan(`◈ ${greeting} · PID ${process.pid}\n`));

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { shutdown('SIGINT');  });

  // An unhandled error in any subsystem otherwise kills this detached/unref'd
  // process silently — daemon.pid is left behind and johnny.log gets no trace.
  // Route both through the normal shutdown path so daemon.pid is cleared and
  // the crash is diagnosable.
  process.on('uncaughtException', (err) => {
    const detail = err?.stack ?? String(err);
    process.stderr.write(neon.red(`× uncaughtException — ${detail}\n`));
    void log(`daemon: uncaughtException — ${detail}`).finally(() => {
      void shutdown('uncaughtException');
    });
  });
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(neon.red(`× unhandledRejection — ${detail}\n`));
    void log(`daemon: unhandledRejection — ${detail}`).finally(() => {
      void shutdown('unhandledRejection');
    });
  });

  // Keep process alive even if all async work is done
  process.stdin.resume();

  // Automatic synthesis: if the user agreed during setup, make sure the launchd
  // heartbeat is loaded (heals a removed or unloaded job). Best-effort.
  try {
    const { readKnowledgeConfig } = await import('../knowledge/config.js');
    if ((await readKnowledgeConfig()).autoSynth === true) {
      const { ensureArmed } = await import('../knowledge/heartbeat.js');
      if (ensureArmed()) await log('daemon: synthesis heartbeat armed');
    }
  } catch { /* never block daemon start */ }
  startModelWarmer();
  await startWatcher();
  startIdleTrigger();
  startEmbedBackfill();

  await log('daemon: all subsystems up');
}
