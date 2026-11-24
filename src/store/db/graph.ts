import * as memoriesDb from './memories.js';
import * as edgesDb from './edges.js';
import * as transcriptsDb from './transcripts.js';
import type { MemoryNode, MemoryFull, MemoryId, Edge, MemoryGraph } from '../../types.js';
import type { JohnnyConfig } from '../../types.js';
import { decodeEmbedding } from '../../utils/embedding-codec.js';

export interface GraphStats {
  totalMemories: number;
  totalEdges: number;
  highestRank: number;
  mostRetrieved: string;
}

export function memoryRecordToNode(record: memoriesDb.MemoryRecord, topics: string[] = []): MemoryNode {
  return {
    id: record.id,
    snapshotName: record.snapshot_name,
    title: record.title,
    summary: record.summary ?? '',
    projectPath: record.project_path ?? '',
    sourceUri: record.source_uri ?? null,
    tokenCount: record.token_count,
    topics,
    retrievalCount: record.retrieval_count,
    lastRetrievedTurn: record.last_retrieved_turn ?? 0,
    lastRetrievedAt: record.last_retrieved_at ?? '',
    createdAtTurn: record.created_at_turn ?? 0,
    createdAt: record.created_at,
    outgoingEdges: {},
    incomingEdges: {},
    rank: record.rank,
    rankUpdatedAtTurn: 0,
  };
}

function nodeToFull(node: MemoryNode, transcriptRec: transcriptsDb.TranscriptRecord | null): MemoryFull {
  let embedding: number[] | null = null;
  if (transcriptRec?.embedding) {
    try { embedding = decodeEmbedding(transcriptRec.embedding); } catch { /* malformed */ }
  }
  return { ...node, transcript: transcriptRec?.transcript ?? '', embedding };
}

function edgeRecordToEdge(record: edgesDb.EdgeRecord): Edge {
  return {
    weight: record.weight,
    coRetrievalCount: record.co_retrieval_count,
    lastReinforcedTurn: record.last_reinforced_turn ?? 0,
    lastReinforcedAt: record.last_reinforced_at ?? '',
    invalidationCount: record.invalidation_count,
    lastInvalidatedTurn: record.last_invalidated_turn,
  };
}

// Bound for interactive callers (hook/CLI) — see getAllEdges()'s comment for
// why this exists. Offline/batch graph analysis (PageRank, sleep
// consolidation) must call loadGraph(Full)?() with no limit for correctness.
export const INTERACTIVE_EDGE_LIMIT = 20_000;

async function hydrateEdges<T extends MemoryNode>(graph: MemoryGraph<T>, edgeLimit?: number): Promise<void> {
  // Single bulk SELECT instead of N×2 per-memory queries — eliminates
  // hundreds of round-trips for a large graph.
  const allEdges = await edgesDb.getAllEdges(edgeLimit);
  for (const edgeRec of allEdges) {
    if (graph.memories[edgeRec.source_id]) {
      graph.memories[edgeRec.source_id].outgoingEdges[edgeRec.target_id] = edgeRecordToEdge(edgeRec);
    }
    if (graph.memories[edgeRec.target_id]) {
      graph.memories[edgeRec.target_id].incomingEdges[edgeRec.source_id] = edgeRecordToEdge(edgeRec);
    }
  }
}

const RECENT_MEMORY_LIMIT = 1500;

export async function loadGraph(edgeLimit?: number): Promise<MemoryGraph<MemoryNode>> {
  // Top 5000 by rank PLUS the most recent by creation time: a brand-new memory has the lowest rank, so a
  // rank-only cap left ~2.5k memories (395 of them from the last two weeks) invisible to recall.
  const [byRank, recent, topicsByMem] = await Promise.all([
    memoriesDb.listMemories({ limit: 5000 }),
    memoriesDb.listMemories({ limit: RECENT_MEMORY_LIMIT, orderBy: 'created_at' }),
    transcriptsDb.getAllTopicsByMemory(),
  ]);
  const memories = [...new Map([...byRank, ...recent].map(r => [r.id, r])).values()];
  const graph: MemoryGraph<MemoryNode> = { version: 1, rankUpdatedAtTurn: 0, memories: {} };
  for (const record of memories) {
    const mem = memoryRecordToNode(record, topicsByMem.get(record.id) ?? []);
    graph.memories[mem.id] = mem;
  }
  await hydrateEdges(graph, edgeLimit);
  return graph;
}

export async function loadGraphFull(edgeLimit?: number): Promise<MemoryGraph<MemoryFull>> {
  const [memories, topicsByMem, allTranscripts] = await Promise.all([
    memoriesDb.listMemories({ limit: 5000 }),
    transcriptsDb.getAllTopicsByMemory(),
    transcriptsDb.getAllTranscripts(),
  ]);
  const graph: MemoryGraph<MemoryFull> = { version: 1, rankUpdatedAtTurn: 0, memories: {} };
  for (const record of memories) {
    const node = memoryRecordToNode(record, topicsByMem.get(record.id) ?? []);
    graph.memories[record.id] = nodeToFull(node, allTranscripts.get(record.id) ?? null);
  }
  await hydrateEdges(graph, edgeLimit);
  return graph;
}

export async function saveGraph<T extends MemoryNode>(graph: MemoryGraph<T>): Promise<void> {
  const updates = Object.entries(graph.memories)
    .filter(([, mem]) => mem.rankUpdatedAtTurn > 0)
    .map(([id, mem]) => ({ id, rank: mem.rank, turn: mem.rankUpdatedAtTurn }));
  await memoriesDb.bulkUpdateMemoryRanks(updates);
}

export function computeLift(edge: Edge, memA: MemoryNode, memB: MemoryNode): number {
  return edge.weight / Math.sqrt(Math.max(1, memA.retrievalCount) * Math.max(1, memB.retrievalCount));
}

export function computeTrust(edge: Edge, lambda: number): number {
  return edge.weight / (edge.weight + edge.invalidationCount * lambda);
}

export function computeEffectiveWeight(edge: Edge, memA: MemoryNode, memB: MemoryNode, lambda: number): number {
  return computeLift(edge, memA, memB) * computeTrust(edge, lambda);
}

export function computeActivation(mem: MemoryNode, currentTurn: number, tau: number): number {
  if (mem.lastRetrievedTurn === 0) return 1.0;
  return Math.exp(-(currentTurn - mem.lastRetrievedTurn) / tau);
}

export function phase1Score(mem: MemoryNode, currentTurn: number, tau: number): number {
  return mem.rank * computeActivation(mem, currentTurn, tau);
}

export function topCandidates<T extends MemoryNode>(graph: MemoryGraph<T>, currentTurn: number, config: JohnnyConfig, k = 5): T[] {
  return Object.values(graph.memories)
    .map(m => ({ m, score: phase1Score(m, currentTurn, config.activationTau) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(x => x.m);
}

export function recomputePageRank<T extends MemoryNode>(graph: MemoryGraph<T>, config: JohnnyConfig, currentTurn: number): void {
  const ids = Object.keys(graph.memories);
  if (ids.length === 0) return;
  const { pageRankDamping: d, invalidationLambda: lambda } = config;
  const N = ids.length;
  let ranks: Record<MemoryId, number> = {};
  for (const id of ids) ranks[id] = 1 / N;

  for (let iter = 0; iter < 100; iter++) {
    const next: Record<MemoryId, number> = {};
    for (const id of ids) next[id] = (1 - d) / N;
    for (const id of ids) {
      const mem = graph.memories[id];
      const outIds = Object.keys(mem.outgoingEdges);
      if (outIds.length === 0) continue;
      const totalWeight = outIds.reduce((sum, tid) => {
        const target = graph.memories[tid];
        return target ? sum + computeEffectiveWeight(mem.outgoingEdges[tid], mem, target, lambda) : sum;
      }, 0);
      if (totalWeight === 0) continue;
      for (const tid of outIds) {
        const target = graph.memories[tid];
        if (!target) continue;
        const ew = computeEffectiveWeight(mem.outgoingEdges[tid], mem, target, lambda);
        next[tid] = (next[tid] ?? (1 - d) / N) + d * ranks[id] * (ew / totalWeight);
      }
    }
    let delta = 0;
    for (const id of ids) delta += Math.abs((next[id] ?? 0) - (ranks[id] ?? 0));
    ranks = next;
    if (delta < 1e-6) break;
  }
  for (const id of ids) {
    graph.memories[id].rank = ranks[id] ?? (1 - d);
    graph.memories[id].rankUpdatedAtTurn = currentTurn;
  }
}

export async function reinforceEdge<T extends MemoryNode>(
  graph: MemoryGraph<T>, fromId: MemoryId, toId: MemoryId, currentTurn: number, config: JohnnyConfig,
): Promise<void> {
  const from = graph.memories[fromId];
  const to = graph.memories[toId];
  if (!from || !to) return;
  const now = new Date().toISOString();
  const delta = config.reinforcementDelta;
  // Await the DB write so tests can read back the edge immediately after reinforcement.
  await edgesDb.reinforceEdge(fromId, toId, delta, currentTurn);
  if (!from.outgoingEdges[toId]) {
    from.outgoingEdges[toId] = { weight: 0, coRetrievalCount: 0, lastReinforcedTurn: currentTurn, lastReinforcedAt: now, invalidationCount: 0, lastInvalidatedTurn: null };
  }
  from.outgoingEdges[toId].weight += delta;
  from.outgoingEdges[toId].coRetrievalCount++;
  from.outgoingEdges[toId].lastReinforcedTurn = currentTurn;
  from.outgoingEdges[toId].lastReinforcedAt = now;
  to.incomingEdges[fromId] = from.outgoingEdges[toId];
  const outIds = Object.keys(from.outgoingEdges);
  if (outIds.length > config.topKOutgoing) {
    let weakestId = outIds[0];
    let weakestW = from.outgoingEdges[weakestId].weight;
    for (const oid of outIds) {
      if (from.outgoingEdges[oid].weight < weakestW) { weakestW = from.outgoingEdges[oid].weight; weakestId = oid; }
    }
    delete from.outgoingEdges[weakestId];
    if (graph.memories[weakestId]) delete graph.memories[weakestId].incomingEdges[fromId];
    await edgesDb.deleteEdge(fromId, weakestId); // persist eviction — was missing (Fix 2.1)
  }
}

// Fire-and-forget — hot path, no await needed
export function recordRetrieval(memoryId: string, turn: number): void {
  memoriesDb.recordRetrieval(memoryId, turn).catch(() => { /* best-effort */ });
}

export async function getGraphStats(): Promise<GraphStats> {
  const [totalMemories, totalEdges, topMem, allMemories] = await Promise.all([
    memoriesDb.getMemoryCount(),
    edgesDb.getTotalEdgeCount(),
    memoriesDb.getTopMemoriesByRank(1),
    memoriesDb.listMemories({ orderBy: 'retrieval_count', limit: 1 }),
  ]);
  return {
    totalMemories,
    totalEdges,
    highestRank: topMem[0]?.rank ?? 0,
    mostRetrieved: allMemories[0]?.snapshot_name ?? 'none',
  };
}
