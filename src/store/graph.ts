import {
  loadGraph as dbLoadGraph,
  loadGraphFull as dbLoadGraphFull,
  saveGraph as dbSaveGraph,
  topCandidates as dbTopCandidates,
  recomputePageRank as dbRecomputePageRank,
  reinforceEdge as dbReinforceEdge,
  recordRetrieval as dbRecordRetrieval,
  computeLift,
  computeTrust,
  computeActivation,
  phase1Score,
  getGraphStats,
  INTERACTIVE_EDGE_LIMIT,
  type GraphStats,
} from './db/graph.js';
import type { MemoryNode, MemoryId, MemoryGraph } from '../types.js';
import type { JohnnyConfig } from '../types.js';

export const readGraph = dbLoadGraph;
export const readGraphFull = dbLoadGraphFull;
export const writeGraph = dbSaveGraph;
export { INTERACTIVE_EDGE_LIMIT };

export function topCandidates<T extends MemoryNode>(
  graph: MemoryGraph<T>,
  currentTurn: number,
  config: JohnnyConfig,
  k: number = 5,
): T[] {
  return dbTopCandidates(graph, currentTurn, config, k);
}

export function recomputePageRank<T extends MemoryNode>(
  graph: MemoryGraph<T>,
  config: JohnnyConfig,
  currentTurn: number,
): void {
  return dbRecomputePageRank(graph, config, currentTurn);
}

export function reinforceEdge<T extends MemoryNode>(
  graph: MemoryGraph<T>,
  fromId: MemoryId,
  toId: MemoryId,
  currentTurn: number,
  config: JohnnyConfig,
): Promise<void> {
  return dbReinforceEdge(graph, fromId, toId, currentTurn, config);
}

export function recordRetrieval(mem: MemoryNode, currentTurn: number): void {
  return dbRecordRetrieval(mem.id, currentTurn);
}

export { computeLift, computeTrust, computeActivation, phase1Score, getGraphStats };
export type { GraphStats };