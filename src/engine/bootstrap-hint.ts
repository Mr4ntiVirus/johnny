// Phase G.7 — Bootstrap landscape hint. One-shot orientation prose emitted
// at session-open so Claude wakes oriented to recent work + topic landscape
// for the project he's in.
//
// Design ground truth: project_johnny_phase_g_design.md (locked 2026-04-25).
// - Project-scoped to cwd. A wake-portal session sees wake-portal memories,
//   not Roku or audio-stack.
// - Three sections: recent work · memory landscape · tool call instructions.
// - ~190 token target; cap at 5 recents and 6 clusters.
// - Pure formatter: no I/O, no clock except injectable `nowIso`. Tests can
//   drive deterministically.
//
// Composition with action emissions (turn 1 still runs the full pipeline):
// the caller prepends bootstrap text to whatever additionalContext the
// action produces, separated by a divider. Bootstrap is the broad
// orientation; the action emission is the specific "look here" hint. They
// serve different purposes — don't try to merge them.
//
// Cooldown: surfacedMemoryIds returns the recent-work memory ids so the
// caller can mark them surfaced. Subsequent hint emissions in the same
// session skip those memories — Claude has already been told about them.

import type { MemoryGraph, MemoryNode } from '../types.js';
import * as path from 'node:path';
import { humanDate } from '../utils/human-date.js';

export interface BootstrapHint {
  text: string;
  // Recent-work memory ids the caller should add to surfaced_memories so
  // they aren't re-surfaced via normal hint/recommend on later turns.
  surfacedMemoryIds: string[];
  // Telemetry: cluster headings shown, useful for "did Claude pull from
  // this cluster after seeing it?" rollups.
  clusterTopics: string[];
}

export interface BootstrapOptions {
  recentLimit?: number;     // max items in "Recent work" (default 3)
  clusterLimit?: number;    // max topic-cluster lines (default 4)
  topicsPerCluster?: number; // topics joined into one cluster line (default 3)
  nowIso?: string;          // injected for deterministic testing
  // Memory ids to exclude from the "Recent work" list. Caller passes the
  // turn-1 action's matched memory id so it doesn't appear twice in the
  // stacked emission (bootstrap recents + Form-3 digest both naming it).
  excludeIds?: string[];
}

const DEFAULT_RECENT_LIMIT = 3;
const DEFAULT_CLUSTER_LIMIT = 4;
const DEFAULT_TOPICS_PER_CLUSTER = 3;

function dateOnly(iso: string): string {
  return (iso ?? '').slice(0, 10);
}

// Most recent of (lastRetrievedAt, createdAt). Sorts by last-touched recency,
// not just creation, so a frequently-pulled memory beats a stale newer one.
function recencyKey(m: MemoryNode): string {
  const lr = m.lastRetrievedAt ?? '';
  const ca = m.createdAt ?? '';
  return lr > ca ? lr : ca;
}

function projectMemories(graph: MemoryGraph, cwd: string): MemoryNode[] {
  const out: MemoryNode[] = [];
  for (const id in graph.memories) {
    const m = graph.memories[id];
    // Exact projectPath match. cwd-prefix matching could come later if real
    // usage shows monorepo subdirs need it, but exact keeps the signal
    // dense and matches how memories are stamped at creation time.
    if (m.projectPath && m.projectPath === cwd) out.push(m);
  }
  return out;
}

function topRecent(memories: MemoryNode[], limit: number): MemoryNode[] {
  return [...memories]
    .sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
    .slice(0, limit);
}

// Aggregate topic counts across all project memories. Returns topics ordered
// by frequency desc, ties broken alphabetically.
function topicCounts(memories: MemoryNode[]): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of memories) {
    for (const t of m.topics ?? []) {
      const k = t.trim().toLowerCase();
      if (k.length === 0) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => (b.count - a.count) || a.topic.localeCompare(b.topic));
}

// Group the ranked topic list into clusters of up to topicsPerCluster topics
// each. The cluster's count is the count of memories that carry ANY of its
// topics (deduped) — that's the user-meaningful "how many memories does this
// area hold" number, not the sum of topic frequencies (which would double-
// count multi-topic memories).
function buildClusters(
  memories: MemoryNode[],
  perCluster: number,
  clusterLimit: number,
): Array<{ topics: string[]; count: number }> {
  const ranked = topicCounts(memories).map(t => t.topic);
  const clusters: Array<{ topics: string[]; count: number }> = [];
  for (let i = 0; i < ranked.length && clusters.length < clusterLimit; i += perCluster) {
    const topics = ranked.slice(i, i + perCluster);
    const set = new Set(topics);
    let count = 0;
    for (const m of memories) {
      if ((m.topics ?? []).some(t => set.has(t.trim().toLowerCase()))) count++;
    }
    if (count > 0) clusters.push({ topics, count });
  }
  return clusters;
}

// Build terse prose narrative from recents. Brand voice: lowercase, gruff, no fluff.
// e.g. "yesterday: implemented recall scorer fix. before that: email pipeline (jun 18), pgbouncer (jun 13)."
function buildRecentNarrative(recents: MemoryNode[], nowIso?: string): string {
  if (recents.length === 0) return '';
  const [first, ...rest] = recents;
  const firstDate = humanDate(recencyKey(first), nowIso);
  const firstSummary = (first.summary ?? first.snapshotName).slice(0, 80).toLowerCase();
  let narrative = `${firstDate}: ${firstSummary}`;
  if (rest.length > 0) {
    const priorParts = rest.map(m => {
      const d = humanDate(recencyKey(m), nowIso);
      const label = (m.topics.slice(0, 2).join(' + ') || m.snapshotName).toLowerCase();
      return `${label} (${d})`;
    });
    narrative += `. before that: ${priorParts.join(', ')}`;
  }
  return narrative;
}

export function buildBootstrapHint(
  graph: MemoryGraph,
  cwd: string,
  opts: BootstrapOptions = {},
): BootstrapHint | null {
  const recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const clusterLimit = opts.clusterLimit ?? DEFAULT_CLUSTER_LIMIT;
  const perCluster = opts.topicsPerCluster ?? DEFAULT_TOPICS_PER_CLUSTER;

  const projMems = projectMemories(graph, cwd);
  // Nothing to orient against — caller skips bootstrap entirely. Returning
  // null also covers the "first-ever session, no memories anywhere" case.
  if (projMems.length === 0) return null;

  const exclude = new Set(opts.excludeIds ?? []);
  const recentsPool = exclude.size > 0
    ? projMems.filter(m => !exclude.has(m.id))
    : projMems;
  const recents = topRecent(recentsPool, recentLimit);
  // Clusters use the full project set — landscape stats shouldn't shift just
  // because one memory is being surfaced via the action emission.
  const clusters = buildClusters(projMems, perCluster, clusterLimit);

  const projLabel = path.basename(cwd) || cwd;
  const totalNoun = projMems.length === 1 ? 'memory' : 'memories';

  const lines: string[] = [];

  // Opening line: location + most recent work narrative
  const narrative = buildRecentNarrative(recents, opts.nowIso);
  lines.push(`back in ${projLabel}/.${ narrative ? `  ${narrative}.` : ''}`);
  lines.push('');

  // Memory count + cluster topics inline. Count is always shown; hot-topics only when present.
  if (clusters.length > 0) {
    const clusterStr = clusters
      .slice(0, clusterLimit)
      .map(c => c.topics.slice(0, 2).join('/').toLowerCase())
      .join(' · ');
    lines.push(`${projMems.length} ${totalNoun}.  hot: ${clusterStr}.`);
  } else {
    lines.push(`${projMems.length} ${totalNoun}.`);
  }

  lines.push('Call johnny_recall now on whichever of the hot topics above looks most relevant to this session — don\'t wait to be asked. johnny_list · johnny_search to browse further.');

  return {
    text: lines.join('\n'),
    surfacedMemoryIds: recents.map(m => m.id),
    clusterTopics: clusters.flatMap(c => c.topics),
  };
}
