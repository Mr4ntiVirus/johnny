// REM sleep analog: discover associative edges that Hebbian co-retrieval missed.
// Memories can be semantically related but never retrieved together; this finds them.
//
// Only runs when both memories have embeddings. O(n²) but bounded and offline.
import type { MemoryFull, MemoryGraph, JohnnyConfig } from '../types.js';
import { cosine } from '../engine/embedder.js';
import { log } from '../utils/log.js';
import * as edgesDb from '../store/db/edges.js';

const TAU_LATENT      = 0.75;  // cosine similarity threshold
const LATENT_WEIGHT   = 0.3;   // weak seed weight — Hebbian reinforcement grows it if real

export interface LatentEdgeResult {
  latentEdgesAdded: number;
}

function topicOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  let shared = 0;
  for (const t of b) if (setA.has(t)) shared++;
  return shared;
}

export async function discoverLatentEdges(
  graph: MemoryGraph<MemoryFull>,
  config: JohnnyConfig,
  currentTurn: number,
): Promise<LatentEdgeResult> {
  let latentEdgesAdded = 0;
  const now = new Date().toISOString();

  const embedded = Object.values(graph.memories).filter(m => m.embedding !== null);
  if (embedded.length < 2) return { latentEdgesAdded: 0 };

  for (let i = 0; i < embedded.length; i++) {
    const a = embedded[i];
    for (let j = i + 1; j < embedded.length; j++) {
      const b = embedded[j];

      // Skip pairs that already have an edge in either direction
      if (a.outgoingEdges[b.id] || b.outgoingEdges[a.id]) continue;

      const sim = cosine(a.embedding!, b.embedding!);
      if (sim < TAU_LATENT) continue;
      if (topicOverlap(a.topics, b.topics) === 0) continue;

      // Respect topKOutgoing cap — only add if under limit
      const addAtoB = Object.keys(a.outgoingEdges).length < config.topKOutgoing;
      const addBtoA = Object.keys(b.outgoingEdges).length < config.topKOutgoing;

      if (addAtoB) {
        const edge = {
          weight: LATENT_WEIGHT,
          coRetrievalCount: 0,
          lastReinforcedTurn: currentTurn,
          lastReinforcedAt: now,
          invalidationCount: 0,
          lastInvalidatedTurn: null,
        };
        a.outgoingEdges[b.id] = edge;
        b.incomingEdges[a.id] = edge;
        try {
          await edgesDb.createEdge({ sourceId: a.id, targetId: b.id, weight: LATENT_WEIGHT, edgeType: 'semantic_similarity', createdAtTurn: currentTurn });
        } catch { /* UNIQUE constraint: concurrent creation, skip */ }
        latentEdgesAdded++;
      }

      if (addBtoA) {
        const edge = {
          weight: LATENT_WEIGHT,
          coRetrievalCount: 0,
          lastReinforcedTurn: currentTurn,
          lastReinforcedAt: now,
          invalidationCount: 0,
          lastInvalidatedTurn: null,
        };
        b.outgoingEdges[a.id] = edge;
        a.incomingEdges[b.id] = edge;
        try {
          await edgesDb.createEdge({ sourceId: b.id, targetId: a.id, weight: LATENT_WEIGHT, edgeType: 'semantic_similarity', createdAtTurn: currentTurn });
        } catch { /* UNIQUE constraint: concurrent creation, skip */ }
        latentEdgesAdded++;
      }
    }
  }

  if (latentEdgesAdded > 0) {
    await log(`sleep/latent-edges: added ${latentEdgesAdded} edges from ${embedded.length} embedded memories`);
  }

  return { latentEdgesAdded };
}
