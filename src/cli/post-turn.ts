import { exitIfBypassed, isBypassed } from '../utils/bypass.js';
import { readState } from '../store/state.js';
import { readConfig } from '../store/config.js';
import { snapshot } from '../actions/snapshot.js';
import { trim } from '../actions/trim.js';
import { analyzeSession } from '../vendor/cmv/core/analyzer.js';
import { getSessionEntry } from '../store/session-map.js';
import {
  claimTrimWindow, claimSnapshotWindow,
  upsertSession,
  DEFAULT_SNAPSHOT_COOLDOWN_MS,
} from '../store/db/sessions.js';
import { recordAction } from '../store/db/action-history.js';
import { log } from '../utils/log.js';
import * as path from 'node:path';

// Percentages are of config.contextLimitTokens (the real, current model context
// window), NOT analysis.contextUsedPercent — that field comes from the vendored
// CMV analyzer's hardcoded 200k-token CONTEXT_LIMIT (src/vendor/cmv/core/analyzer.ts),
// which is stale on current 1M-context models and must not be used for gating.
// 14% of 1M ≈ 140k tokens — the trim threshold originally intended when this
// constant was tuned as "70% of 200k".
const AUTO_TRIM_THRESHOLD = 14;         // % context pressure that justifies losslessly trimming
// Snapshot at ~90k tokens (9% of 1M) — captures meaningful reasoning blocks without
// flooding on every short tool-use turn. Cooldown (2 min) is the primary rate limiter;
// delta check inside snapshot.ts drops empty captures.
const AUTO_SNAPSHOT_THRESHOLD = 9;
const MIN_SIZE_BYTES = 100_000;         // skip bookkeeping on tiny sessions
const TRIM_COOLDOWN_MS = 30_000;        // per-session floor between trims
const SNAPSHOT_COOLDOWN_MS = DEFAULT_SNAPSHOT_COOLDOWN_MS;

// Core logic — accepts transcript path + session id directly.
// Called by the hook handler (runPostTurn) and the daemon watcher (runPostTurnForPath).
export async function runPostTurnForPath(
  transcriptPath: string,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  if (isBypassed()) return;

  // Derive sessionId from filename if not provided (Claude JSONL: <session_id>.jsonl)
  const sid = sessionId ?? path.basename(transcriptPath, '.jsonl');

  try {
    const { stat } = await import('node:fs/promises');
    let info;
    try {
      info = await stat(transcriptPath);
    } catch (statErr: any) {
      if (statErr?.code === 'ENOENT') {
        // Transcript was rotated/removed between hook fire and now — normal,
        // not an error. Just skip this turn (not logged: happens in routine
        // bursts whenever Claude Code's own session housekeeping runs).
        return;
      }
      throw statErr;
    }
    if (info.size < MIN_SIZE_BYTES) return;

    // Resolve cwd: caller-supplied > session-map lookup > empty (memory will have blank projectPath)
    let resolvedCwd = cwd ?? '';
    if (!resolvedCwd) {
      const entry = await getSessionEntry(sid).catch(() => null);
      resolvedCwd = entry?.lastCwd ?? '';
    }

    const [analysis, state, config] = await Promise.all([
      analyzeSession(transcriptPath),
      readState(),
      readConfig(),
    ]);

    // Recompute against the real configured context limit — see comment on
    // AUTO_TRIM_THRESHOLD above for why analysis.contextUsedPercent can't be used directly.
    const cmvPressure = Math.round((analysis.estimatedTokens / config.contextLimitTokens) * 100);

    // Ensure the session row exists before calling claimTrimWindow /
    // claimSnapshotWindow. Both functions do an atomic UPDATE … WHERE session_id = ?
    // which matches 0 rows and returns false when the session is not yet in the DB.
    // This happens in tests (useTestDb truncates sessions) and in fresh Claude sessions
    // where evaluate.ts hasn't fired yet.
    await upsertSession({ sessionId: sid, lastCwd: resolvedCwd || undefined }).catch(() => { /* best-effort */ });

    // Trim is lossless context hygiene — fire it during long agentic stretches
    // where evaluate.ts (UserPromptSubmit) doesn't run. Without this, trim only
    // happens at user prompt boundaries; multi-tool-call assistant turns can
    // accumulate hundreds of bloated lines before the next opportunity to trim.
    if (cmvPressure >= AUTO_TRIM_THRESHOLD) {
      // Atomic claim: one winner per cooldown window; all concurrent losers skip.
      if (await claimTrimWindow(sid, TRIM_COOLDOWN_MS)) {
        await trim(transcriptPath);
        // The delta cursor is content-addressed (snapshot-delta.ts: anchor uuid +
        // global ledger), so a trim no longer needs to reset anything. The old
        // `setLastSnapshotLine(sid, 0)` here made the next snapshot re-capture the
        // whole post-trim file — the main source of duplicate chunks.
        await log(`post-turn: trim fired (cmvPressure=${cmvPressure}%)`);
        // Record the action so the dashboard's ACTIONS KPI reflects reality —
        // trims fired from PostToolUse otherwise wouldn't show up alongside
        // trims fired from UserPromptSubmit. Source attribution lives in turn=0
        // (post-turn doesn't have a per-session turn counter the way evaluate does).
        try {
          await recordAction({
            sessionId: sid, turn: state.turnCounter, recallScore: null,
            cmvPressure, limitPressure: null, action: 'trim',
            matchedMemoryId: null, durationMs: null,
          });
        } catch (e) { await log(`post-turn: recordAction failed: ${e}`); }
      }
    }

    // Snapshot is a checkpoint of new reasoning, not a pressure-relief operation.
    // Delta semantics make it cheap; the cooldown is the actual rate limit;
    // snapshot.ts drops empty deltas internally.
    if (cmvPressure >= AUTO_SNAPSHOT_THRESHOLD) {
      // Atomic claim: one winner per cooldown window stamps last_snapshot_at and
      // proceeds; all others exit immediately. Eliminates the read-check-write
      // race that fired repeated snapshots on every PostToolUse during agentic runs.
      if (!await claimSnapshotWindow(sid, SNAPSHOT_COOLDOWN_MS)) {
        return;
      }
      const result = await snapshot(transcriptPath, sid, resolvedCwd, state.turnCounter, false);
      // Record snapshot attempts (success or null) so the ACTIONS KPI reflects
      // post-turn snapshot activity alongside evaluate.ts decisions.
      if (result.snapshotName) {
        try {
          await recordAction({
            sessionId: sid, turn: state.turnCounter, recallScore: null,
            cmvPressure, limitPressure: null, action: 'snapshot_passthrough',
            matchedMemoryId: null, durationMs: null,
          });
        } catch (e) { await log(`post-turn: recordAction failed: ${e}`); }
      }
    }
  } catch (err) {
    await log(`post-turn ERROR: ${err}`);
  }
}

export async function runPostTurn(): Promise<void> {
  exitIfBypassed();

  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  let payload: { transcript_path?: string; session_id?: string; cwd?: string };
  try {
    payload = JSON.parse(input);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const { transcript_path, session_id, cwd } = payload;
  if (!transcript_path || !session_id) {
    process.stdout.write('{}');
    return;
  }

  try {
    await runPostTurnForPath(transcript_path, session_id, cwd);
    process.stdout.write('{}');
  } catch (err) {
    await log(`post-turn ERROR: ${err}`);
    process.stdout.write('{}');
  }
}
