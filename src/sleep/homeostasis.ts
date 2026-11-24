// Synaptic downscaling analog: aggressive pruning + global weight normalization.
// Awake pruning (store/graph.ts) is conservative because the user is watching.
// Sleep pruning runs tighter thresholds because they're not.
import type { MemoryGraph, JohnnyConfig } from '../types.js';
import { computeLift, computeTrust } from '../store/graph.js';
import { getSnapshot } from '../vendor/cmv/core/metadata-store.js';
import { log } from '../utils/log.js';
import * as edgesDb from '../store/db/edges.js';

// Thresholds looser than awake: ANY 2 of 3 conditions triggers prune (awake requires all 3)
const SLEEP_LIFT_FLOOR      = 0.1;   // awake: 0.05
const SLEEP_TRUST_FLOOR     = 0.2;   // awake: 0.1
const SLEEP_DORMANCY_TURNS  = 1000;  // awake default: 2000 (homeostasis is more aggressive)

// Homeostatic weight cap: if total edge weight sum exceeds this, rescale globally
const WEIGHT_SUM_MAX    = 1000;
const WEIGHT_SUM_TARGET = 750;

// Archive threshold: low-rank, low-retrieval, no incoming edges
const ARCHIVE_RANK_FLOOR          = 0.02;
const ARCHIVE_MAX_RETRIEVAL_COUNT = 1;
const ARCHIVE_MAX_LAST_TURN       = 2000; // memory was last retrieved 2000+ turns ago

export interface HomeostasisResult {
  edgesPruned: number;
  memoriesArchived: number;
  orphansArchived: number;
  rescaleApplied: boolean;
  scaleFactor: number;
}

export interface RescaleOptions {
  // Optional: override snapshot lookup for orphan detection (tests inject
  // a stub to avoid hitting the on-disk CMV index). If omitted, the real
  // metadata-store is used.
  snapshotExists?: (snapshotName: string) => Promise<boolean>;
}

export async function rescaleAndPrune(
  graph: MemoryGraph,
  config: JohnnyConfig,
  currentTurn: number,
  opts: RescaleOptions = {},
): Promise<HomeostasisResult> {
  const result: HomeostasisResult = {
    edgesPruned: 0,
    memoriesArchived: 0,
    orphansArchived: 0,
    rescaleApplied: false,
    scaleFactor: 1,
  };

  const memories = Object.values(graph.memories);
  if (memories.length < 2) return result;

  // 0. Orphan detection — check if CMV snapshots exist
  // This was the original logic that caused mass deletion:
  //   for (const mem of memories) {
  //     if (mem.snapshotName.startsWith('blend-')) continue;
  //     const exists = await getSnapshot(mem.snapshotName);
  //     if (!exists) { archive(mem); }
  //   }
  //
  // PROBLEM: getSnapshot() was checking ~/.cmv/index.json which gets cleaned by Claude compaction!
  // This caused 32 memories to be deleted every sleep pass.
  //
  // LESSON: We should NOT depend on CMV snapshots for memory persistence.
  // Johnny's memory IS the source of truth, not CMV.
  const orphaned = 0;

  // Re-read surviving memories after orphan pass
  const survivors = Object.values(graph.memories);
  if (survivors.length < 2) return result;

  // Archive map (kept for compatibility but not used since orphan detection is disabled)
  const archived: typeof graph.memories = {};

  // Protect the 3 most recently retrieved memories from any pruning
  const protected_ids = new Set(
    [...survivors]
      .sort((a, b) => b.lastRetrievedTurn - a.lastRetrievedTurn)
      .slice(0, 3)
      .map(m => m.id),
  );

  // 1. Aggressive edge pruning — ANY 2 of 3 conditions
  for (const mem of survivors) {
    if (protected_ids.has(mem.id)) continue;
    for (const [toId, edge] of Object.entries(mem.outgoingEdges)) {
      const toMem = graph.memories[toId];
      if (!toMem) { delete mem.outgoingEdges[toId]; result.edgesPruned++; continue; }

      const dormant  = currentTurn - edge.lastReinforcedTurn >= SLEEP_DORMANCY_TURNS;
      const lowLift  = computeLift(edge, mem, toMem)          < SLEEP_LIFT_FLOOR;
      const lowTrust = computeTrust(edge, config.invalidationLambda) < SLEEP_TRUST_FLOOR;

      const conditions = [dormant, lowLift, lowTrust].filter(Boolean).length;
      if (conditions >= 2) {
        delete mem.outgoingEdges[toId];
        delete toMem.incomingEdges[mem.id];
        result.edgesPruned++;
        await edgesDb.deleteEdge(mem.id, toId);
      }
    }
  }

  // 2. Memory archival DISABLED — user wants to keep all memories
  // (Kept logic for reference but not executing)
  const memoriesArchived = 0;

  // 3. Homeostatic rescaling — cap total edge weight sum
  let totalWeight = 0;
  for (const mem of Object.values(graph.memories)) {
    for (const edge of Object.values(mem.outgoingEdges)) {
      totalWeight += edge.weight;
    }
  }

  if (totalWeight > WEIGHT_SUM_MAX) {
    const scale = WEIGHT_SUM_TARGET / totalWeight;
    for (const mem of Object.values(graph.memories)) {
      for (const edge of Object.values(mem.outgoingEdges)) {
        edge.weight *= scale;
      }
    }
    await edgesDb.rescaleAllEdgeWeights(scale);
    result.rescaleApplied = true;
    result.scaleFactor = scale;
    await log(`sleep/homeostasis: rescaled weights by ${scale.toFixed(4)} (Σ ${totalWeight.toFixed(1)} → ${WEIGHT_SUM_TARGET})`);
  }

  return result;
}
