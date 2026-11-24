// johnny doctor — live observability dashboard.
//
// Single-column plain-text layout. No inner panel borders, no flex
// distribution, no fixed heights. Every row is a self-contained <Text>.
// The previous border-and-flex approach hit Ink rendering bugs that ate
// the first row of every panel and clipped left-side characters.
//
// Usage:
//   johnny doctor          # interactive (q to quit, r to restart the daemon)
//   johnny doctor --once   # one-shot text snapshot for piping/scripts

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import { log } from '../../utils/log.js';
import { startDaemonCore, restartDaemonCore } from './daemon.js';
import type { Action } from '../../types.js';
import { knowledgeRows } from '../../store/knowledge-view.js';
import {
  C, ALL_ACTIONS, ACTION_DISPLAY, SUBSYSTEM_INTERVALS,
  age, fmtBytes, statusGlyph, decorateLogLine,
  collectStats, type DoctorSnapshot, type DecoratedLine,
} from '../../store/stats.js';

const REFRESH_MS = 2000;
const RULE_WIDTH = 72;

// ── Helpers (TUI text-formatting only — stats gathering lives in store/stats.ts) ──

function pad(s: string, n: number): string {
  return (s + ' '.repeat(n)).slice(0, n);
}

function lpad(s: string, n: number): string {
  return (' '.repeat(n) + s).slice(-n);
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}


// ── Single-column rendering ──────────────────────────────────────────────────
//
// Each section returns a flat list of <Text> rows with no inner <Box>. The
// root <Box flexDirection="column"> stacks them. Nothing is bordered, nothing
// is flex-stretched. This sidesteps the Ink layout bugs that were eating
// rows.

// A panel: full-width bordered box with a colored title and arbitrary children.
// Vertical-only stacking (never side-by-side) — that was the layout that ate
// rows in the previous design.
function Panel({ title, children, grow, titleColor }: { title: string; children: React.ReactNode; grow?: boolean; titleColor?: string }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={C.dim} paddingX={1} marginBottom={0} flexGrow={grow ? 1 : 0}>
      <Text color={titleColor ?? C.cyan} bold>{title}</Text>
      {children}
    </Box>
  );
}

function kv(key: string, value: string, valueColor: string = C.fg): React.ReactElement {
  return (
    <Text key={`kv-${key}`}>
      <Text color={C.dim}>{pad(key, 18)}</Text>
      <Text color={valueColor}>{value}</Text>
    </Text>
  );
}

// Horizontal bar for action distribution. width chars wide, filled proportional
// to count/max. When max is 0 (no activity yet), shows an empty rail rather
// than blowing up — distinguishes "no data" from "tiny data."
function bar(count: number, max: number, width = 10): { filled: string; empty: string } {
  if (max <= 0) return { filled: '', empty: '░'.repeat(width) };
  const f = Math.round((count / max) * width);
  return { filled: '█'.repeat(f), empty: '░'.repeat(width - f) };
}

function HeaderPanel({ snap }: { snap: DoctorSnapshot }) {
  const time = snap.ts.toISOString().slice(11, 19);
  const sess = snap.activeSessionId?.slice(0, 8) ?? '—';
  return (
    <Box borderStyle="single" borderColor={C.cyan} paddingX={1} flexDirection="column">
      <Box>
        <Text color={C.cyan} bold>JOHNNY NEUROMORPHIC</Text>
        <Text color={C.dim}>  ·  </Text>
        <Text color={C.magenta}>positronik.ai</Text>
      </Box>
      <Box>
        <Text color={C.dim}>turn </Text>
        <Text color={C.fg}>{snap.currentTurn}</Text>
        <Text color={C.dim}>  ·  </Text>
        <Text color={C.fg}>{time}</Text>
        <Text color={C.dim}>  ·  session </Text>
        <Text color={C.fg}>{sess}</Text>
      </Box>
    </Box>
  );
}

function CompactStatusPanel({ snap }: { snap: DoctorSnapshot }) {
  const eS = snap.ollamaLatency.embedSamples;
  const cS = snap.ollamaLatency.classifySamples;
  const latency = eS > 0
    ? `  embed ${snap.ollamaLatency.embed}ms`
    : cS > 0 ? `  classify ${snap.ollamaLatency.classify}ms` : '';
  const beats = new Map(snap.heartbeats.map(b => [b.subsystem, b]));
  const SHORT: Record<string, string> = {
    'model-warmer': 'warmer', 'watcher': 'watch',
    'rank-refresher': 'rank λ', 'idle-trigger': 'idle',
  };
  return (
    <Panel title="SYSTEM">
      <Text>
        <Text color={C.dim}>status  </Text>
        <Text color={snap.bypassed ? C.amber : C.green}>{snap.bypassed ? 'BYPASSED' : 'active'}</Text>
        <Text color={C.dim}>  daemon </Text>
        <Text color={snap.daemonAlive ? C.green : C.red}>{snap.daemonAlive ? `✓ ${snap.daemonPid}` : '✗ offline'}</Text>
        <Text color={C.dim}>  ollama </Text>
        <Text color={snap.ollamaUp ? C.green : C.red}>{snap.ollamaUp ? '✓' : '✗'}</Text>
        <Text color={C.dim}>{latency}</Text>
      </Text>
      {/* Split subsystems across two rows (3+3) so they fit a narrow half-column */}
      {[Object.keys(SUBSYSTEM_INTERVALS).slice(0, 3), Object.keys(SUBSYSTEM_INTERVALS).slice(3)].map((group, row) => (
        <Text key={row}>
          <Text color={C.dim}>{row === 0 ? 'subsys  ' : '        '}</Text>
          {group.map((name, i) => {
            const s = statusGlyph(beats.get(name), name);
            return (
              <Text key={name}>
                {i > 0 && <Text color={C.dim}>  </Text>}
                <Text color={C.dim}>{SHORT[name] ?? name} </Text>
                <Text color={s.color}>{s.glyph}{s.ageStr}</Text>
              </Text>
            );
          })}
        </Text>
      ))}
    </Panel>
  );
}

function ActiveSessionPanel({ snap }: { snap: DoctorSnapshot }) {
  const last = snap.recentActions[0];
  const lastAct = last
    ? `${ACTION_DISPLAY[last.action as Action] ?? last.action}  ${last.cmv ?? '—'}%  ${age(last.ts)}`
    : 'none yet';
  const snapAge = snap.activeSessionLastSnap ? age(snap.activeSessionLastSnap) : 'never';
  const trimAge = snap.activeSessionLastTrim ? age(snap.activeSessionLastTrim) : 'never';
  const newestStr = snap.newestMemoryName
    ? `${snap.newestMemoryName.slice(0, 20)}  (${age(snap.newestMemoryAt)})`
    : 'none';
  const kvS = (key: string, val: string) => (
    <Text key={`kv-${key}`}>
      <Text color={C.dim}>{pad(key, 12)}</Text>
      <Text color={C.fg}>{val}</Text>
    </Text>
  );
  return (
    <Panel title="SESSION">
      {kvS('action', lastAct)}
      {kvS('snap / trim', `${snapAge} / ${trimAge}`)}
      {kvS('newest', newestStr)}
    </Panel>
  );
}

function ActionsPanel({ snap }: { snap: DoctorSnapshot }) {
  const counts = new Map(snap.actions.map(a => [a.action, a.count]));
  const lastFired = new Map(snap.actions.map(a => [a.action, a.lastFiredAt]));
  const max = Math.max(0, ...ALL_ACTIONS.map(a => counts.get(a) ?? 0));
  return (
    <Panel title="ACTIONS (last 100 turns)" grow titleColor={C.amber}>
      <Box flexDirection="column" flexGrow={1} justifyContent="space-between">
        {ALL_ACTIONS.map(action => {
          const count = counts.get(action) ?? 0;
          const last = lastFired.get(action);
          const b = bar(count, max);
          const labelColor = count > 0 ? C.fg : C.dim;
          const fillColor = count > 0 ? C.amber : C.dim;
          return (
            <Text key={action}>
              <Text color={labelColor}>{pad(ACTION_DISPLAY[action], 13)}</Text>
              <Text color={fillColor}>{b.filled}</Text>
              <Text color={C.dim}>{b.empty}</Text>
              <Text color={count > 0 ? C.fg : C.dim}>{lpad(String(count), 4)}</Text>
              <Text color={C.dim}>{count > 0 ? `  ${age(last)}` : ''}</Text>
            </Text>
          );
        })}
      </Box>
    </Panel>
  );
}

function RecentActionsPanel({ snap }: { snap: DoctorSnapshot }) {
  return (
    <Panel title="RECENT ACTIONS">
      {snap.recentActions.length === 0 && (
        <Text color={C.dim}>  none yet — submit a prompt to populate</Text>
      )}
      {snap.recentActions.map((a, i) => (
        <Text key={i}>
          <Text color={C.dim}>{pad(age(a.ts) + ' ago', 8)} </Text>
          <Text color={C.fg}>{pad(a.action, 22)}</Text>
          <Text color={C.dim}>turn </Text>
          <Text color={C.fg}>{lpad(String(a.turn), 4)}</Text>
          <Text color={C.dim}>  cmv=</Text>
          <Text color={(a.cmv ?? 0) >= 70 ? C.amber : C.fg}>{lpad(String(a.cmv ?? '—'), 3)}%</Text>
          <Text color={C.dim}>  lim=</Text>
          <Text color={C.fg}>{lpad(String(a.lim ?? '—'), 3)}%</Text>
        </Text>
      ))}
    </Panel>
  );
}

function GraphPanel({ snap }: { snap: DoctorSnapshot }) {
  const churnAlert = snap.snapshotsLastHour > 30;
  return (
    <Panel title="GRAPH & THROUGHPUT">
      {kv('memories', String(snap.graphStats.totalMemories))}
      {kv('edges', String(snap.graphStats.totalEdges))}
      {kv('snapshots/hr', `${snap.snapshotsLastHour}${churnAlert ? '  ⚠ above target' : ''}`, churnAlert ? C.amber : C.fg)}
      {kv('trims/hr', String(snap.trimLastHour))}
      {kv('hint→recall', `${snap.conversion.recallsTriggered}/${snap.conversion.hintsEmitted}  (${Math.round(snap.conversion.conversionRate * 100)}%)`)}
    </Panel>
  );
}

// Ground-truth KPI: memories captured per time window, queried directly from
// the memories table. Independent of which code path created them — covers
// post-turn snapshots, evaluate-action snapshots, snapshot-now invocations,
// and skill creations alike. This is the canary for "is Johnny actually
// remembering anything?"
// LIVE LOG: latest decorated lines from ~/.johnny/johnny.log. Same content as
// `johnny watch` (default mode, noise filtered). Provides at-a-glance visibility
// into what Johnny is actually doing right now.
function LiveLogPanel({ snap }: { snap: DoctorSnapshot }) {
  const decorated = snap.recentLogLines
    .map(decorateLogLine)
    .filter((d): d is DecoratedLine => d !== null)
    .slice(-12);
  return (
    <Panel title="LIVE LOG (johnny watch)">
      {decorated.length === 0 && (
        <Text color={C.dim}>  no recent activity</Text>
      )}
      {decorated.map((d, i) => (
        <Text key={i}>
          <Text color={C.dim}>{d.ts}  </Text>
          <Text color={d.color}>{pad(d.glyph, 2)}</Text>
          <Text color={d.color}>{d.text.slice(0, 64)}</Text>
        </Text>
      ))}
    </Panel>
  );
}

function CompactMemoriesPanel({ snap }: { snap: DoctorSnapshot }) {
  const pct = snap.graphStats.totalMemories > 0
    ? Math.round((snap.totalMemoriesRecalled / snap.graphStats.totalMemories) * 100)
    : 0;
  const cH = snap.memoriesLastHour > 0 ? C.green : C.dim;
  const rH = snap.recallsLastHour > 0 ? C.cyan : C.dim;
  return (
    <Panel title="MEMORIES">
      <Text>
        <Text color={C.dim}>captured  </Text>
        <Text color={cH}>{snap.memoriesLastHour}</Text>
        <Text color={C.dim}>h  </Text>
        <Text color={snap.memoriesLastDay > 0 ? C.fg : C.dim}>{snap.memoriesLastDay}</Text>
        <Text color={C.dim}>d  </Text>
        <Text color={snap.memoriesLastWeek > 0 ? C.fg : C.dim}>{snap.memoriesLastWeek}</Text>
        <Text color={C.dim}>w  total </Text>
        <Text color={C.fg}>{snap.graphStats.totalMemories}</Text>
      </Text>
      <Text>
        <Text color={C.dim}>recalled  </Text>
        <Text color={rH}>{snap.recallsLastHour}</Text>
        <Text color={C.dim}>h  </Text>
        <Text color={snap.recallsLastDay > 0 ? C.fg : C.dim}>{snap.recallsLastDay}</Text>
        <Text color={C.dim}>d  </Text>
        <Text color={snap.recallsLastWeek > 0 ? C.fg : C.dim}>{snap.recallsLastWeek}</Text>
        <Text color={C.dim}>w  ever </Text>
        <Text color={snap.totalMemoriesRecalled > 0 ? C.cyan : C.dim}>{snap.totalMemoriesRecalled}/{snap.graphStats.totalMemories}</Text>
        <Text color={C.dim}>  ({pct}%)</Text>
      </Text>
    </Panel>
  );
}

function OllamaPanel({ snap }: { snap: DoctorSnapshot }) {
  const models = snap.ollamaModels;
  return (
    <Panel title="OLLAMA">
      {models.length === 0
        ? <Text color={C.dim}>  no models loaded</Text>
        : models.map((m, i) => {
            const expires = m.expiresAt ? new Date(m.expiresAt) : null;
            const expiresIn = expires ? Math.max(0, Math.round((expires.getTime() - Date.now()) / 60_000)) : null;
            return (
              <Text key={i}>
                <Text color={C.cyan}>  {m.name.slice(0, 22).padEnd(22)}</Text>
                <Text color={C.dim}>  {fmtBytes(m.sizeVram)}</Text>
                {expiresIn !== null && (
                  <Text color={expiresIn < 2 ? C.amber : C.dim}>  {expiresIn > 100000 ? 'keep-alive' : `${expiresIn}m`}</Text>
                )}
              </Text>
            );
          })
      }
    </Panel>
  );
}

function KnowledgePanel({ snap }: { snap: DoctorSnapshot }) {
  return (
    <Panel title="KNOWLEDGE" titleColor={C.magenta}>
      {knowledgeRows(snap.knowledge).map(r => (
        <Text key={r.label}>
          <Text color={C.dim}>{r.label.padEnd(8)}</Text>
          {r.segments.map((seg, i) => <Text key={i} color={seg.color}>{seg.text}</Text>)}
        </Text>
      ))}
    </Panel>
  );
}

function StoragePanel({ snap }: { snap: DoctorSnapshot }) {
  return (
    <Panel title="STORAGE">
      {kv('sqlite · johnny.db', fmtBytes(snap.localDb.bytes))}
    </Panel>
  );
}

function DbPathsPanel({ snap }: { snap: DoctorSnapshot }) {
  const { localDb, lastRecall } = snap;
  const localColor = localDb.reachable ? C.green : C.red;
  const localGlyph = localDb.reachable ? '✓' : '×';
  return (
    <Panel title="DB PATHS" titleColor={C.magenta}>
      <Text>
        <Text color={C.dim}>  {'sqlite'.padEnd(10)}</Text>
        <Text color={localColor}>{localGlyph} </Text>
        <Text color={C.fg}>{localDb.memories}m</Text>
        <Text color={C.dim}>  {localDb.actionsToday}a</Text>
        <Text color={localDb.recallsToday > 0 ? C.cyan : C.dim}>  {localDb.recallsToday}r</Text>
      </Text>
      {lastRecall && (
        <Text>
          <Text color={C.dim}>  {'recall'.padEnd(10)}</Text>
          <Text color={lastRecall.source === 'local-sqlite' ? C.green : C.amber}>
            {lastRecall.source === 'local-sqlite' ? 'hot ' : 'cld '}
          </Text>
          <Text color={C.cyan}>{lastRecall.match.slice(0, 14)}</Text>
          <Text color={C.dim}>  {lastRecall.similarity}%  {age(lastRecall.ts)}</Text>
        </Text>
      )}
      {!lastRecall && (
        <Text color={C.dim}>  recall      —</Text>
      )}
    </Panel>
  );
}

function ErrorsPanel({ snap }: { snap: DoctorSnapshot }) {
  const fatal = snap.fatalCountLastHour;
  const error = snap.errorCountLastHour;
  const warn = snap.warningCountLastHour;
  const benign = snap.benignCountLastHour;
  return (
    <Panel title="ERRORS (last hour)">
      {kv('fatal', String(fatal), fatal > 0 ? C.red : C.dim)}
      {kv('error', String(error), error > 0 ? C.amber : C.dim)}
      {kv('warning', String(warn), warn > 0 ? C.amber : C.dim)}
      {kv('benign', String(benign))}
      {snap.recentErrors.length > 0 && (
        <Text color={C.dim}>  recent:</Text>
      )}
      {snap.recentErrors.slice(0, 3).map((e, i) => (
        <Text key={i}>
          <Text color={
            e.severity === 'fatal' ? C.red :
            e.severity === 'error' ? C.amber :
            e.severity === 'warning' ? C.amber : C.dim
          }>  {pad(e.severity, 8)}</Text>
          <Text color={C.fg}>{pad(e.source, 12)}</Text>
          <Text color={C.dim}>{e.message.slice(0, 32)}</Text>
        </Text>
      ))}
    </Panel>
  );
}

type RestartPhase = 'idle' | 'restarting' | 'done' | 'error';
interface RestartUiState { phase: RestartPhase; message: string }

function FooterLine({ restart }: { restart: RestartUiState }) {
  const restartColor = restart.phase === 'error' ? C.red : restart.phase === 'restarting' ? C.amber : C.cyan;
  return (
    <Box paddingX={1}>
      <Text color={C.dim}>
        q quit · r restart daemon · refresh 2s
        {restart.phase !== 'idle' && <Text color={restartColor}>{'  ·  '}{restart.message}</Text>}
      </Text>
    </Box>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

function DoctorApp({ initial }: { initial: DoctorSnapshot }) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<DoctorSnapshot>(initial);
  const [restartState, setRestartState] = useState<RestartUiState>({ phase: 'idle', message: '' });
  const restartingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await collectStats();
        if (!cancelled) setSnap(next);
      } catch { /* keep last */ }
    };
    const t = setInterval(tick, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Auto-clear the restart status message a few seconds after it lands —
  // the next 2s stats poll already picks up the new daemonPid/daemonAlive,
  // this is just transient feedback that the keypress did something.
  useEffect(() => {
    if (restartState.phase !== 'done' && restartState.phase !== 'error') return;
    const t = setTimeout(() => setRestartState({ phase: 'idle', message: '' }), 4000);
    return () => clearTimeout(t);
  }, [restartState.phase]);

  const triggerRestart = () => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestartState({ phase: 'restarting', message: 'restarting daemon…' });
    restartDaemonCore()
      .then(result => {
        setRestartState(
          result.status === 'restarted'
            ? { phase: 'done', message: `daemon restarted · PID ${result.newPid}` }
            : { phase: 'error', message: 'daemon restart failed · check johnny.log' },
        );
      })
      .catch(() => {
        setRestartState({ phase: 'error', message: 'daemon restart failed · check johnny.log' });
      })
      .finally(() => { restartingRef.current = false; });
  };

  useInput((input, key) => {
    if (input === 'q' || key.escape) { exit(); return; }
    if (input === 'r') { triggerRestart(); return; }
  });

  // Single-column flat layout. No inner borders. No height constraints.
  return (
    <Box flexDirection="column">
      <HeaderPanel snap={snap} />
      {/* Two-column body between header and live log. Each column is its OWN
          flexDirection="column" Box so bordered panels stack inside it without
          being children of the row flex container — that was the layout that
          ate first rows in the earlier design. */}
      <Box flexDirection="row">
        <Box flexDirection="column" width="50%" flexShrink={0}>
          <CompactStatusPanel snap={snap} />
          <ActiveSessionPanel snap={snap} />
          <CompactMemoriesPanel snap={snap} />
          <DbPathsPanel snap={snap} />
        </Box>
        <Box flexDirection="column" width="50%" flexShrink={0}>
          <ActionsPanel snap={snap} />
          <OllamaPanel snap={snap} />
          <StoragePanel snap={snap} />
          <KnowledgePanel snap={snap} />
        </Box>
      </Box>
      <LiveLogPanel snap={snap} />
      <FooterLine restart={restartState} />
    </Box>
  );
}

// ── Plain-text fallback for --once mode ──────────────────────────────────────

function printOnce(snap: DoctorSnapshot): void {
  const w = (s: string) => process.stdout.write(s + '\n');
  const time = snap.ts.toISOString().slice(11, 19);
  const sess = snap.activeSessionId?.slice(0, 8) ?? '—';

  w('');
  w(`JOHNNY NEUROMORPHIC · ${time} · turn ${snap.currentTurn} · session ${sess}`);

  const heading = (label: string) => w(` ${label} ` + '─'.repeat(Math.max(2, RULE_WIDTH - label.length - 2)));

  const beats = new Map(snap.heartbeats.map(b => [b.subsystem, b]));
  const SHORT: Record<string, string> = { 'model-warmer': 'warmer', 'watcher': 'watch', 'rank-refresher': 'rank λ', 'idle-trigger': 'idle' };
  const subsysStr = Object.keys(SUBSYSTEM_INTERVALS).map(n => {
    const s = statusGlyph(beats.get(n), n);
    return `${SHORT[n] ?? n} ${s.glyph}${s.ageStr}`;
  }).join('  ');
  const eS = snap.ollamaLatency.embedSamples;
  const latencyStr = eS > 0 ? `  embed ${snap.ollamaLatency.embed}ms` : '';

  heading('SYSTEM');
  w(`  status ${snap.bypassed ? 'BYPASSED' : 'active'}  daemon ${snap.daemonAlive ? `✓ ${snap.daemonPid}` : '✗'}  ollama ${snap.ollamaUp ? '✓' : '✗'}${latencyStr}`);
  w(`  subsys  ${subsysStr}`);

  heading('SESSION');
  const last = snap.recentActions[0];
  const lastAct = last ? `${ACTION_DISPLAY[last.action as Action] ?? last.action}  cmv=${last.cmv ?? '—'}%  ${age(last.ts)} ago` : 'none yet';
  const snapAge = snap.activeSessionLastSnap ? age(snap.activeSessionLastSnap) + ' ago' : 'never';
  const trimAge = snap.activeSessionLastTrim ? age(snap.activeSessionLastTrim) + ' ago' : 'never';
  w(`  action   ${lastAct}`);
  w(`  snap / trim  ${snapAge} / ${trimAge}`);
  w(`  newest   ${snap.newestMemoryName ? `${snap.newestMemoryName.slice(0, 40)} (${age(snap.newestMemoryAt)} ago)` : 'none'}`);

  heading('ACTIONS (last 100)');
  const counts = new Map(snap.actions.map(a => [a.action, a.count]));
  const lastFired = new Map(snap.actions.map(a => [a.action, a.lastFiredAt]));
  for (const action of ALL_ACTIONS) {
    const c = counts.get(action) ?? 0;
    const lf = lastFired.get(action);
    w(`  ${pad(ACTION_DISPLAY[action], 13)}${lpad(String(c), 4)}   last: ${c > 0 ? age(lf) + ' ago' : '—'}`);
  }

  const pct = snap.graphStats.totalMemories > 0 ? Math.round((snap.totalMemoriesRecalled / snap.graphStats.totalMemories) * 100) : 0;
  heading('MEMORIES');
  w(`  captured  ${snap.memoriesLastHour}h  ${snap.memoriesLastDay}d  ${snap.memoriesLastWeek}w  total ${snap.graphStats.totalMemories}`);
  w(`  recalled  ${snap.recallsLastHour}h  ${snap.recallsLastDay}d  ${snap.recallsLastWeek}w  ever ${snap.totalMemoriesRecalled}/${snap.graphStats.totalMemories} (${pct}%)`);

  heading('OLLAMA');
  if (snap.ollamaModels.length === 0) {
    w('  no models loaded');
  } else {
    for (const m of snap.ollamaModels) {
      const exp = m.expiresAt ? Math.max(0, Math.round((new Date(m.expiresAt).getTime() - Date.now()) / 60_000)) : null;
      w(`  ${m.name.slice(0, 22).padEnd(22)}  ${fmtBytes(m.sizeVram)}${exp !== null ? `  ${exp > 100000 ? 'keep-alive' : `${exp}m`}` : ''}`);
    }
  }

  heading('STORAGE');
  w(`  sqlite · johnny.db ${fmtBytes(snap.localDb.bytes)}`);

  heading('KNOWLEDGE');
  for (const r of knowledgeRows(snap.knowledge)) w(`  ${r.label.padEnd(8)}${r.segments.map(x => x.text).join('')}`);

  heading('DB PATHS');
  const lc = snap.localDb;
  w(`  sqlite      ${lc.reachable ? '✓' : '×'} ${lc.memories}m  ${lc.actionsToday}a  ${lc.recallsToday}r`);
  if (snap.lastRecall) {
    const lr = snap.lastRecall;
    w(`  recall      hot ${lr.match.slice(0, 14)}  ${lr.similarity}%  ${age(lr.ts)}`);
  }

  heading('LIVE LOG');
  const decorated = snap.recentLogLines
    .map(decorateLogLine)
    .filter((d): d is DecoratedLine => d !== null)
    .slice(-12);
  if (decorated.length === 0) w('  no recent activity');
  for (const d of decorated) {
    w(`  ${d.ts}  ${pad(d.glyph, 2)}${d.text.slice(0, 64)}`);
  }
  w('');
}

// ── Entry ────────────────────────────────────────────────────────────────────

// /goal Johnny Doctor must bootstrap all system components on each launch.
// If the daemon died (e.g. silently, while the Mac was idle), spawn it before
// the first render so subsystem heartbeats start recovering immediately,
// rather than showing everything offline for the whole session.
async function bootstrapDaemonIfDead(snapshot: DoctorSnapshot): Promise<DoctorSnapshot> {
  if (snapshot.daemonAlive) return snapshot;

  const result = await startDaemonCore();
  if (result.status === 'started' || result.status === 'already-on') {
    await log(`doctor: auto-spawned daemon · PID ${result.pid}`);
    return collectStats();
  }
  await log('doctor: daemon auto-spawn failed · check ~/.johnny/johnny.log');
  return snapshot;
}

// Machine-readable snapshot for GUIs (Johnny Doctor menu-bar app). Derived fields reuse the TUI's own logic
// (statusGlyph, decorateLogLine, ACTION_DISPLAY) so the GUI and TUI can never disagree.
function toJson(snap: DoctorSnapshot): unknown {
  const beats = new Map(snap.heartbeats.map(b => [b.subsystem, b]));
  const SHORT: Record<string, string> = { 'model-warmer': 'warmer', 'watcher': 'watch', 'rank-refresher': 'rank λ', 'idle-trigger': 'idle' };
  const counts = new Map(snap.actions.map(a => [a.action, a]));
  return {
    ...snap,
    ts: snap.ts.toISOString(),
    activeSessionLastTrim: snap.activeSessionLastTrim ? new Date(snap.activeSessionLastTrim).toISOString() : null,
    activeSessionLastSnap: snap.activeSessionLastSnap ? new Date(snap.activeSessionLastSnap).toISOString() : null,
    subsystems: Object.keys(SUBSYSTEM_INTERVALS).map(n => { const g = statusGlyph(beats.get(n), n); return { name: n, short: SHORT[n] ?? n, glyph: g.glyph, age: g.ageStr, status: g.status }; }),
    actionRows: ALL_ACTIONS.map(a => ({ action: a, label: ACTION_DISPLAY[a], count: counts.get(a)?.count ?? 0, lastFiredAt: counts.get(a)?.lastFiredAt ?? null, lastAge: counts.get(a)?.count ? age(counts.get(a)?.lastFiredAt) : null })),
    lastActionLabel: snap.recentActions[0] ? { label: ACTION_DISPLAY[snap.recentActions[0].action as Action] ?? snap.recentActions[0].action, cmv: snap.recentActions[0].cmv, age: age(snap.recentActions[0].ts) } : null,
    snapAge: snap.activeSessionLastSnap ? age(snap.activeSessionLastSnap) : 'never',
    trimAge: snap.activeSessionLastTrim ? age(snap.activeSessionLastTrim) : 'never',
    newestAge: snap.newestMemoryAt ? age(snap.newestMemoryAt) : null,
    recallAge: snap.lastRecall ? age(snap.lastRecall.ts) : null,
    liveLog: snap.recentLogLines.map(decorateLogLine).filter((d): d is DecoratedLine => d !== null).slice(-12),
    ollamaModelRows: snap.ollamaModels.map(m => ({ name: m.name, size: fmtBytes(m.sizeVram), expiresInMin: m.expiresAt ? Math.max(0, Math.round((new Date(m.expiresAt).getTime() - Date.now()) / 60_000)) : null })),
    storageText: { sqlite: fmtBytes(snap.localDb.bytes) },
    knowledgeRows: knowledgeRows(snap.knowledge),
  };
}

export async function cmdDoctor(args: string[]): Promise<void> {
  // johnny doctor --json            one snapshot as JSON
  // johnny doctor --start-daemon    the TUI's launch-time bootstrap (start daemon if dead)
  // johnny doctor --restart-daemon  the TUI's `r` key
  if (args.includes('--restart-daemon')) {
    const r = await restartDaemonCore();
    console.log(JSON.stringify(r));
    process.exit(r.status === 'restarted' ? 0 : 1);
  }
  if (args.includes('--start-daemon')) {
    const snap = await bootstrapDaemonIfDead(await collectStats());
    console.log(JSON.stringify({ daemonAlive: snap.daemonAlive, daemonPid: snap.daemonPid }));
    process.exit(0);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(toJson(await collectStats())));
    process.exit(0);
  }
  const onceMode = args.includes('--once');
  let initial = await collectStats();
  initial = await bootstrapDaemonIfDead(initial);
  if (onceMode) {
    printOnce(initial);
    process.exit(0);
  }

  process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // clear screen + scrollback before TUI takes over
  const { waitUntilExit } = render(<DoctorApp initial={initial} />);
  await waitUntilExit();

  process.exit(0);
}
