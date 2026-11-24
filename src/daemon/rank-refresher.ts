// Periodically recomputes PageRank and runs conservative edge pruning.
// SQLite WAL mode gives us write serialization — no external lock needed.
import { readGraph, writeGraph, recomputePageRank, computeLift, computeTrust } from '../store/graph.js';
import { readState } from '../store/state.js';
import { readConfig } from '../store/config.js';
import { deleteEdge } from '../store/db/edges.js';
import { getRankUpdatedTurn, setRankUpdatedTurn } from '../store/db/state.js';
import { recordHeartbeat } from '../store/db/heartbeats.js';
import { log } from '../utils/log.js';

const POLL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setTimeout> | null = null;

export async function refresh(): Promise<void> {
  // Heartbeat fires on every tick — even when there's nothing to refresh.
  try { recordHeartbeat('rank-refresher'); } catch { /* best-effort */ }

  // Cheap check first — no edges fetched. Only pay for the full unbounded
  // readGraph() (all edges, needed for correct PageRank) when a recompute is
  // actually due. Previously this compared against graph.rankUpdatedAtTurn,
  // a MemoryGraph-level field that loadGraph() always hardcodes to 0 — so the
  // full graph was fetched unconditionally every tick regardless of whether
  // anything was stale, which wastes CPU every hour.
  const [state, config, rankUpdatedAtTurn] = await Promise.all([
    readState(), readConfig(), getRankUpdatedTurn(),
  ]);
  const currentTurn = state.turnCounter;

  const staleTurns = currentTurn - rankUpdatedAtTurn;
  if (staleTurns < config.rankRefreshEveryTurns) return;

  const graph = await readGraph();
  recomputePageRank(graph, config, currentTurn);
  await setRankUpdatedTurn(currentTurn);

  // Conservative pruning: all three conditions must hold.
  // writeGraph() only persists rank — edge deletions must hit SQLite directly
  // via deleteEdge(), or they vanish on the next readGraph().
  let pruned = 0;
  for (const mem of Object.values(graph.memories)) {
    for (const [toId, edge] of Object.entries(mem.outgoingEdges)) {
      const target = graph.memories[toId];
      if (!target) {
        delete mem.outgoingEdges[toId];
        await deleteEdge(mem.id, toId);
        pruned++;
        continue;
      }
      const lift = computeLift(edge, mem, target);
      const trust = computeTrust(edge, config.invalidationLambda);
      const dormant = (currentTurn - edge.lastReinforcedTurn) >= config.pruneDormancyTurns;
      if (lift < config.pruneLiftFloor && trust < config.pruneTrustFloor && dormant) {
        delete mem.outgoingEdges[toId];
        delete target.incomingEdges[mem.id];
        await deleteEdge(mem.id, toId);
        pruned++;
      }
    }
  }

  await writeGraph(graph);
  // Stamp didWork=true now that we've actually refreshed PageRank.
  try { recordHeartbeat('rank-refresher', { didWork: true }); } catch { /* best-effort */ }
  await log(`rank-refresher: PageRank updated turn=${currentTurn} pruned=${pruned}`);
}

let isRefreshing = false;

export function startRankRefresher(): void {
  const tick = async () => {
    if (!isRefreshing) {
      isRefreshing = true;
      try {
        await Promise.race([
          refresh(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('tick timeout')), 25_000),
          ),
        ]);
      } catch (e) { await log(`rank-refresher error: ${e}`); }
      finally { isRefreshing = false; }
    }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
}

export function stopRankRefresher(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
