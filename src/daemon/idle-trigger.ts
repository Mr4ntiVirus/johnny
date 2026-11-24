// Idle detection → sleep-phase consolidation trigger.
// Watches ~/.claude/projects/ activity timestamps. After IDLE_THRESHOLD_MS without
// any JSONL change, runs sleep-phase consolidation in-process (latent edges, schema
// extraction, edge pruning), then arms again on next activity.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getClaudeProjectsDir } from '../vendor/cmv/utils/paths.js';
import { log } from '../utils/log.js';
import { recordHeartbeat } from '../store/db/heartbeats.js';

const POLL_MS = 60_000;                  // check every minute
const IDLE_THRESHOLD_MS = 15 * 60_000;   // 15 min of no activity → sleep

// Floor idle time at how long this daemon process has actually been alive, so
// stale mtimes on old transcripts can't manufacture a false instant trigger right
// after the daemon starts.
const DAEMON_STARTED_AT = Date.now();

let timer: ReturnType<typeof setTimeout> | null = null;
let consolidatedThisIdlePeriod = false;

async function newestJsonlMtime(): Promise<number> {
  let newest = 0;
  try {
    const projects = await fs.readdir(getClaudeProjectsDir(), { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(getClaudeProjectsDir(), p.name);
      try {
        const files = await fs.readdir(projDir);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const st = await fs.stat(path.join(projDir, f));
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      } catch { /* dir removed mid-scan */ }
    }
  } catch { /* projects dir missing */ }
  return newest;
}

async function check(): Promise<void> {
  // Heartbeat — the subsystem is alive on every tick, even when idle.
  try { recordHeartbeat('idle-trigger'); } catch { /* best-effort */ }

  const newest = await newestJsonlMtime();
  const idleMs = Math.min(Date.now() - newest, Date.now() - DAEMON_STARTED_AT);

  if (idleMs >= IDLE_THRESHOLD_MS) {
    if (!consolidatedThisIdlePeriod) {
      await log(`idle: ${Math.round(idleMs / 60_000)}min quiet — running sleep consolidation`);
      try {
        const { runConsolidation } = await import('../sleep/index.js');
        const report = await runConsolidation();
        try { recordHeartbeat('idle-trigger', { didWork: true }); } catch { /* best-effort */ }
        await log(report
          ? `idle: consolidation done in ${report.durationMs}ms`
          : 'idle: nothing to consolidate');
      } catch (e) {
        await log(`idle: consolidation failed — ${e}`);
        try { recordHeartbeat('idle-trigger', { status: 'error' }); } catch { /* best-effort */ }
      }
      consolidatedThisIdlePeriod = true;
    }
  } else {
    // Activity resumed — re-arm for next idle period
    consolidatedThisIdlePeriod = false;
  }
}

export function startIdleTrigger(): void {
  const tick = async () => {
    try { await check(); } catch (e) { await log(`idle-trigger error: ${e}`); }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
}

export function stopIdleTrigger(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
