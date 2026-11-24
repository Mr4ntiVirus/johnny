import { readState } from '../../store/state.js';
import { readGraph, getGraphStats, INTERACTIVE_EDGE_LIMIT } from '../../store/graph.js';
import { readSessionMap } from '../../store/session-map.js';
import { isBypassed } from '../../utils/bypass.js';
import { isOllamaOnline } from '../../utils/llm.js';
import { neon, dim } from '../../brand/tokens.js';
import { isPidAlive, readDaemonPid } from '../../utils/pid.js';
import { printBanner } from '../../brand/banner.js';
import { top, bot, div, row, section, field, menuItem, hint } from '../../brand/bbs.js';

const w = (s: string) => process.stdout.write(s + '\n');

async function daemonStatus(): Promise<{ label: string; color: typeof neon.cyan }> {
  const pid = await readDaemonPid();
  if (pid && isPidAlive(pid)) return { label: `online  ·  PID ${pid}`, color: neon.cyan };
  return { label: 'offline', color: dim.fg };
}

export async function cmdStatus(): Promise<void> {
  await printBanner();

  const [state, graph, sessionMap, bypassed, ollamaUp, daemon, dbStats] = await Promise.all([
    readState().catch(() => null),
    readGraph(INTERACTIVE_EDGE_LIMIT).catch(() => null),
    readSessionMap().catch(() => null),
    Promise.resolve(isBypassed()),
    isOllamaOnline(),
    daemonStatus(),
    getGraphStats().catch(() => null),
  ]);

  const memCount      = dbStats?.totalMemories ?? Object.keys(graph?.memories ?? {}).length;
  const edgeCount    = dbStats?.totalEdges ?? Object.keys(graph?.memories ?? {}).reduce(
    (sum, id) => sum + Object.keys(graph?.memories?.[id]?.outgoingEdges ?? {}).length, 0
  );

  w(top());
  w(row(''));
  w(section('status'));
  w(row(''));

  // System state
  w(field('STATUS',   bypassed ? 'BYPASSED' : 'ACTIVE',       bypassed ? neon.amber : neon.cyan));
  w(field('DAEMON',   daemon.label,                            daemon.color));
  w(field('OLLAMA',   ollamaUp ? 'online' : 'offline · blind', ollamaUp ? neon.green : neon.red));
  w(row(''));
  w(div());
  w(section('wetware'));
  w(row(''));

  // Memory stats
  w(field('MEMORIES',  String(memCount)));
  w(field('EDGES',     String(edgeCount)));
  w(field('TURNS',     String(state?.turnCounter ?? 0)));
  w(field('SESSION',   sessionMap?.activeSessionId?.slice(0, 24) ?? 'none'));
  w(row(''));
  w(div());
  w(section('commands'));
  w(row(''));

  w(menuItem(1, 'graph',        neon.cyan));
  w(menuItem(2, 'recall',       neon.cyan));
  w(menuItem(3, 'dump',         neon.cyan));
  w(menuItem(4, 'snapshot-now', dim.fg));
  w(menuItem(5, 'sleep',        dim.fg));
  w(menuItem(6, 'disable',      neon.amber));
  w(row(''));

  if (!ollamaUp) {
    w(hint('start ollama to enable embedding and classification'));
    w(row(''));
  }
  if (bypassed) {
    w(hint('run /enable to restore johnny'));
    w(row(''));
  }

  w(bot());
  w('');
}
