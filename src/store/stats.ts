// Shared stats-gathering for `johnny doctor` (TUI) and `johnny stats --json`
// (machine-readable, consumed by the web dashboard via terminal-server.js).
// Extracted from doctor.tsx so both consumers share one data contract instead
// of duplicating queries — see DoctorSnapshot below.
import { isBypassed } from '../utils/bypass.js';
import { isOllamaOnline, getOllamaLatency } from '../utils/llm.js';
import { isPidAlive, readDaemonPid } from '../utils/pid.js';
import { queryOne } from './db-client.js';
import {
  getActionDistribution,
  getLastFiredAt,
  countActionSince,
  getRecentActions,
} from './db/action-history.js';
import { getHeartbeats, type HeartbeatRecord } from './db/heartbeats.js';
import { getRecentErrors, getErrorRollup, countErrorsSince } from './db/error-telemetry.js';
import { getGraphStats } from './graph.js';
import { computeConversionRollup } from './db/telemetry.js';
import { readState } from './state.js';
import { getActiveSession, getLastSnapshotAt, getLastTrimAt } from './db/sessions.js';
import { listMemories } from './db/memories.js';
import { PATHS } from './paths.js';
import * as fs from 'node:fs';
import { collectKnowledgeStats, type KnowledgeStats } from './knowledge-stats.js';
import type { Action } from '../types.js';

// ── Brand (mirrors src/brand/tokens.ts hex values — kept as plain strings
// here since this module has no chalk dependency and is imported by both the
// Ink TUI and the plain-JSON CLI path) ────────────────────────────────────────
export const C = {
  cyan: '#00FFE0',
  magenta: '#FF2EA6',
  green: '#00FF66',
  amber: '#FFB000',
  red: '#FF3860',
  fg: '#D8E4FF',
  dim: '#4A5568',
};

export const ALL_ACTIONS: Action[] = [
  'passthrough',
  'trim',
  'snapshot_passthrough',
  'recommend_memory',
  'suggest_memories',
  'offer',
  'mcp_recall',
];

// hard_switch is intentionally absent: gateHardSwitch demotes it to recommend_memory unless allowHardSwitch is on.

// Display labels for the ACTIONS panel — fit within a half-width column.
export const ACTION_DISPLAY: Record<Action, string> = {
  passthrough: 'passthrough',
  trim: 'trim',
  snapshot_passthrough: 'snapshot',
  recommend_memory: 'recommend',
  hard_switch: 'hard_switch',
  suggest_memories: 'suggest',
  offer: 'offer',
  mcp_recall: 'mcp_recall',
};

// Each subsystem's expected pulse interval. 2× = stalled.
// rank-refresher runs once a day — threshold is 25h, not 30s.
export const SUBSYSTEM_INTERVALS: Record<string, number> = {
  'model-warmer': 30_000,
  'watcher': 60_000,
  'rank-refresher': 25 * 60 * 60 * 1000,
  'idle-trigger': 60_000,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

export function age(ts: string | Date | null | undefined): string {
  if (!ts) return 'never';
  const ms = Date.now() - (ts instanceof Date ? ts.getTime() : new Date(ts).getTime());
  if (ms < 0) return 'now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export function fmtBytes(b: number): string {
  if (b === 0) return '—';
  if (b < 1_048_576) return `${Math.round(b / 1024)}kb`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)}mb`;
  return `${(b / 1_073_741_824).toFixed(2)}gb`;
}

export interface StatusGlyph { glyph: string; color: string; ageStr: string; status: 'ok' | 'warn' | 'error' | 'never' }

export function statusGlyph(beat: HeartbeatRecord | undefined, subsystem: string): StatusGlyph {
  if (!beat) return { glyph: '○', color: C.dim, ageStr: 'never', status: 'never' };
  const ageMs = Date.now() - new Date(beat.last_pulse).getTime();
  const expected = SUBSYSTEM_INTERVALS[subsystem] ?? 60_000;
  if (beat.status === 'error') return { glyph: '×', color: C.red, ageStr: age(beat.last_pulse), status: 'error' };
  if (ageMs > expected * 2) return { glyph: '×', color: C.red, ageStr: age(beat.last_pulse), status: 'error' };
  if (ageMs > expected) return { glyph: '!', color: C.amber, ageStr: age(beat.last_pulse), status: 'warn' };
  return { glyph: '✓', color: C.green, ageStr: age(beat.last_pulse), status: 'ok' };
}

// ── Data types ───────────────────────────────────────────────────────────────

export interface LastRecallEvent {
  query: string;
  match: string;
  similarity: number;
  method: string;
  source: 'local-sqlite';
  ts: string;
}

export interface DoctorSnapshot {
  bypassed: boolean;
  daemonPid: number | null;
  daemonAlive: boolean;
  localDb: { bytes: number; memories: number; actionsToday: number; recallsToday: number; reachable: boolean };
  lastRecall: LastRecallEvent | null;
  ollamaUp: boolean;
  ollamaLatency: { embed: number; classify: number; embedSamples: number; classifySamples: number };
  heartbeats: HeartbeatRecord[];
  actions: { action: string; count: number; lastFiredAt: string | null }[];
  recentActions: { ts: string; action: string; turn: number; cmv: number | null; lim: number | null }[];
  lastTrimAt: string | null;
  lastSnapshotAction: string | null;
  snapshotsLastHour: number;
  trimLastHour: number;
  graphStats: { totalMemories: number; totalEdges: number };
  memoriesLastHour: number;
  memoriesLastDay: number;
  memoriesLastWeek: number;
  recallsLastHour: number;
  recallsLastDay: number;
  recallsLastWeek: number;
  totalMemoriesRecalled: number;
  conversion: { hintsEmitted: number; recallsTriggered: number; conversionRate: number };
  errors: { source: string; severity: string; count: number }[];
  fatalCountLastHour: number;
  errorCountLastHour: number;
  warningCountLastHour: number;
  benignCountLastHour: number;
  recentErrors: { ts: string; source: string; severity: string; message: string }[];
  currentTurn: number;
  activeSessionId: string | null;
  activeSessionLastTrim: Date | null;
  activeSessionLastSnap: Date | null;
  newestMemoryName: string | null;
  newestMemoryAt: string | null;
  recentLogLines: string[];
  ts: Date;
  ollamaModels: { name: string; sizeVram: number; expiresAt: string }[];
  knowledge: KnowledgeStats | null;
}

// Mirror of watch.ts decorators — same glyph + color mapping so the doctor's
// LIVE LOG panel (and the web dashboard's) reads identically to `johnny watch`.
export interface LogDecorator {
  test: RegExp;
  glyph: string;
  color: string;
  noise?: boolean; // hidden in non-verbose mode
}
export const LOG_DECORATORS: LogDecorator[] = [
  { test: /ERROR|error:|FATAL/,                                       glyph: '×',    color: C.red    },
  { test: /^trim:/,                                                   glyph: '▞',    color: C.green  },
  { test: /^pre-compact:/,                                            glyph: '▞',    color: C.green  },
  { test: /^snapshot:/,                                               glyph: '◈',    color: C.cyan   },
  { test: /^recommend:/,                                              glyph: '⇌',    color: C.cyan   },
  { test: /^suggest:/,                                                glyph: '⇌',    color: C.cyan   },
  { test: /^hard-switch:/,                                            glyph: '⟳',    color: C.amber  },
  { test: /^bootstrap:/,                                              glyph: '⎆',    color: C.cyan   },
  { test: /^sleep(\/|:)/,                                             glyph: '☾',    color: C.amber  },
  { test: /^(daemon|watcher|model-warmer|rank-refresher|idle):/,      glyph: '⚙',    color: C.amber  },
  { test: /^action=passthrough/,                                      glyph: '·',    color: C.dim, noise: true  },
  { test: /^action=/,                                                 glyph: '▶',    color: C.fg     },
  { test: /^post-turn:/,                                              glyph: '⌁',    color: C.dim },
];

function shortTime(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : iso.slice(0, 8);
}

export interface DecoratedLine { ts: string; glyph: string; color: string; text: string; }

export function decorateLogLine(line: string): DecoratedLine | null {
  if (!line) return null;
  const sp = line.indexOf(' ');
  if (sp === -1) return null;
  const ts = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  const dec = LOG_DECORATORS.find(d => d.test.test(rest));
  if (dec?.noise) return null; // skip noise lines (passthrough churn, post-turn pulses)
  return {
    ts: shortTime(ts),
    glyph: dec ? dec.glyph : '·',
    color: dec ? dec.color : C.dim,
    text: rest,
  };
}

// Read the tail of the live log file. Best-effort: file may not exist yet.
function readRecentLogLines(maxLines: number): string[] {
  try {
    const stat = fs.statSync(PATHS.log);
    // Read up to last 32KB — plenty for ~100 lines, cheap.
    const fd = fs.openSync(PATHS.log, 'r');
    try {
      const len = Math.min(stat.size, 32_768);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, stat.size - len);
      const all = buf.toString('utf8').split('\n').filter(Boolean);
      return all.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

// ── Ollama + Storage helpers ─────────────────────────────────────────────────

const OLLAMA_BASE = process.env.JOHNNY_OLLAMA_URL ?? 'http://localhost:11434';

async function fetchOllamaModels(): Promise<{ name: string; sizeVram: number; expiresAt: string }[]> {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3_000);
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const data = await res.json() as { models?: { name: string; size_vram: number; expires_at: string }[] };
    return (data.models ?? []).map(m => ({ name: m.name, sizeVram: m.size_vram, expiresAt: m.expires_at }));
  } catch { return []; }
}

async function probeLocalDb(): Promise<DoctorSnapshot['localDb']> {
  try {
    const { query: lq } = await import('./local-db.js');
    const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const RECALL_ACTIONS = `action IN ('recommend_memory','offer','suggest_memories','hard_switch','mcp_recall')`;
    const [mems, acts, recalls] = await Promise.all([
      lq<{n:number}>('SELECT COUNT(*) AS n FROM memories'),
      lq<{n:number}>('SELECT COUNT(*) AS n FROM action_history WHERE ts >= ?', [oneDayAgo]),
      lq<{n:number}>(`SELECT COUNT(*) AS n FROM action_history WHERE ${RECALL_ACTIONS} AND ts >= ?`, [oneDayAgo]),
    ]);
    const stat = fs.statSync(PATHS.database);
    return { bytes: stat.size, memories: mems[0]?.n ?? 0, actionsToday: acts[0]?.n ?? 0, recallsToday: recalls[0]?.n ?? 0, reachable: true };
  } catch { return { bytes: 0, memories: 0, actionsToday: 0, recallsToday: 0, reachable: false }; }
}

function readLastRecall(): LastRecallEvent | null {
  try {
    const raw = fs.readFileSync(PATHS.lastRecall, 'utf-8');
    return JSON.parse(raw) as LastRecallEvent;
  } catch { return null; }
}

// Cap slow probes (Ollama, knowledge stats) so one stall doesn't block the dashboard.
// .unref() ensures the timer doesn't prevent process exit.
function raceTimeout<T>(p: Promise<T>, fallback: T, ms = 2000): Promise<T> {
  return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms).unref())]);
}

export async function collectStats(): Promise<DoctorSnapshot> {
  return collectWithLocalStore();
}

// "Recalled" = memories surfaced to Claude by ANY path: legacy hints/MCP recalls (action_history) plus
// automatic knowledge priming (prime_events outcome='primed'), which never writes an action_history row.
const RECALL_ACTIONS_SQL = `action IN ('recommend_memory','offer','suggest_memories','hard_switch','mcp_recall')`;
async function countRecalls(sinceIso: string): Promise<{ n: number }> {
  const a = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM action_history WHERE ${RECALL_ACTIONS_SQL} AND ts >= ?`, [sinceIso]);
  let primed = 0;
  try {
    primed = (await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM prime_events WHERE outcome = 'primed' AND created_at >= ?`, [sinceIso]))?.n ?? 0;
  } catch { /* prime_events absent on an old store */ }
  return { n: (a?.n ?? 0) + primed };
}

async function collectWithLocalStore(): Promise<DoctorSnapshot> {
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const oneWeekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const pid = await readDaemonPid();
  const [graphStats, state] = await Promise.all([getGraphStats(), readState()]);

  const [
    mLastHour, mLastDay, mLastWeek,
    rLastHour, rLastDay, rLastWeek, totalRecalled,
    active, newestArr, recent, recentErrors,
    heartbeats, actions,
    lastTrimAt, lastSnapshotAction,
    snapshotsLastHour, trimLastHour,
    conversion, errors,
    fatalCountLastHour, errorCountLastHour, warningCountLastHour, benignCountLastHour,
  ] = await Promise.all([
    queryOne<{n:number}>('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?', [oneHourAgo]),
    queryOne<{n:number}>('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?', [oneDayAgo]),
    queryOne<{n:number}>('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?', [oneWeekAgo]),
    countRecalls(oneHourAgo),
    countRecalls(oneDayAgo),
    countRecalls(oneWeekAgo),
    queryOne<{n:number}>('SELECT COUNT(*) AS n FROM memories WHERE retrieval_count > 0'),
    getActiveSession(),
    listMemories({ limit: 1, orderBy: 'created_at' }),
    getRecentActions(8),
    getRecentErrors(5),
    // Heartbeats written to local SQLite by daemon (dual-write) — read directly.
    getHeartbeats(),
    getActionDistribution(100),
    getLastFiredAt('trim'),
    getLastFiredAt('snapshot_passthrough'),
    countActionSince('snapshot_passthrough', oneHourAgo),
    countActionSince('trim', oneHourAgo),
    computeConversionRollup(oneHourAgo),
    getErrorRollup(oneHourAgo),
    countErrorsSince(oneHourAgo, 'fatal'),
    countErrorsSince(oneHourAgo, 'error'),
    countErrorsSince(oneHourAgo, 'warning'),
    countErrorsSince(oneHourAgo, 'benign'),
  ]);
  const newest = newestArr[0];
  const [activeLastTrim, activeLastSnap] = active
    ? await Promise.all([getLastTrimAt(active.session_id), getLastSnapshotAt(active.session_id)])
    : [null, null];

  const localDb = await probeLocalDb();

  return {
    bypassed: isBypassed(),
    daemonPid: pid,
    daemonAlive: pid ? isPidAlive(pid) : false,
    ollamaUp: await isOllamaOnline(),
    ollamaLatency: getOllamaLatency(),
    heartbeats,
    actions,
    recentActions: recent.map(r => ({ ts: r.ts, action: r.action, turn: r.turn, cmv: r.cmv_pressure, lim: r.limit_pressure })),
    lastTrimAt,
    lastSnapshotAction,
    snapshotsLastHour,
    trimLastHour,
    graphStats: { totalMemories: graphStats.totalMemories, totalEdges: graphStats.totalEdges },
    memoriesLastHour: mLastHour?.n ?? 0,
    memoriesLastDay: mLastDay?.n ?? 0,
    memoriesLastWeek: mLastWeek?.n ?? 0,
    recallsLastHour: rLastHour?.n ?? 0,
    recallsLastDay: rLastDay?.n ?? 0,
    recallsLastWeek: rLastWeek?.n ?? 0,
    totalMemoriesRecalled: totalRecalled?.n ?? 0,
    conversion,
    errors,
    fatalCountLastHour,
    errorCountLastHour,
    warningCountLastHour,
    benignCountLastHour,
    recentErrors: recentErrors.map(r => ({ ts: r.ts, source: r.source, severity: r.severity, message: r.message })),
    currentTurn: state.turnCounter,
    activeSessionId: active?.session_id ?? null,
    activeSessionLastTrim: activeLastTrim,
    activeSessionLastSnap: activeLastSnap,
    newestMemoryName: newest?.snapshot_name ?? null,
    newestMemoryAt: newest?.created_at ?? null,
    recentLogLines: readRecentLogLines(12),
    ts: new Date(),
    ollamaModels: await fetchOllamaModels(),
    localDb,
    lastRecall: readLastRecall(),
    knowledge: await raceTimeout(collectKnowledgeStats(), null, 8000),
  };
}
