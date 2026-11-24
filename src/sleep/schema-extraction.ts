// Slow-wave sleep analog: cluster topic-similar memories into parent "schema" nodes.
// Episodes stay as children (never deleted). Schemas add retrieval shortcuts for
// groups of related memories. Rollback = delete the schema Memory node.
//
// Clustering: Jaccard topic similarity ≥ τ_topic, reinforced by cosine embedding
// similarity if embeddings are available. Clusters of ≥ MIN_CLUSTER memories get
// a schema. Schemas are skipped on re-run if they already exist.
import type { MemoryFull, MemoryGraph, JohnnyConfig } from '../types.js';
import { cosine } from '../engine/embedder.js';
import { generateUUID } from '../vendor/cmv/utils/id.js';
import { log } from '../utils/log.js';
import { findMemoryBySnapshot } from '../store/memory.js';
import * as memoriesDb from '../store/db/memories.js';
import * as transcriptsDb from '../store/db/transcripts.js';

const TAU_TOPIC    = 0.35;  // Jaccard topic similarity floor
const TAU_EMBED    = 0.70;  // cosine similarity bonus threshold
const MIN_CLUSTER  = 3;     // minimum cluster size to warrant a schema

export interface SchemaExtractionResult {
  schemasCreated: number;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setB) if (setA.has(t)) inter++;
  return inter / (setA.size + setB.size - inter || 1);
}

function clusterMemories(memories: MemoryFull[]): MemoryFull[][] {
  const visited = new Set<string>();
  const clusters: MemoryFull[][] = [];

  for (const seed of memories) {
    if (visited.has(seed.id)) continue;
    const cluster: MemoryFull[] = [seed];
    visited.add(seed.id);

    for (const candidate of memories) {
      if (visited.has(candidate.id)) continue;
      const j = jaccard(seed.topics, candidate.topics);
      if (j < TAU_TOPIC) continue;

      // Optional cosine bonus — if both have embeddings, require similarity ≥ TAU_EMBED
      if (seed.embedding && candidate.embedding) {
        const cos = cosine(seed.embedding, candidate.embedding);
        if (cos < TAU_EMBED) continue;
      }

      cluster.push(candidate);
      visited.add(candidate.id);
    }

    if (cluster.length >= MIN_CLUSTER) clusters.push(cluster);
  }

  return clusters;
}

function buildSchemaMemory(cluster: MemoryFull[], currentTurn: number): MemoryFull {
  const now = new Date().toISOString();

  // Union topics, pick top 12
  const topicFreq: Record<string, number> = {};
  for (const m of cluster) {
    for (const t of m.topics) {
      topicFreq[t] = (topicFreq[t] ?? 0) + 1;
    }
  }
  const topics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t);

  // Average embedding if all members have one
  let embedding: number[] | null = null;
  if (cluster.every(m => m.embedding !== null)) {
    const dim = cluster[0].embedding!.length;
    const avg = new Array<number>(dim).fill(0);
    for (const m of cluster) {
      for (let i = 0; i < dim; i++) avg[i] += m.embedding![i];
    }
    embedding = avg.map(v => v / cluster.length);
  }

  // Generate human-readable name from the cluster content
  const cleanTopic = (topic: string) => topic.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
  const dominantTopic = cleanTopic(topics[0] ?? 'sessions');
  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  const dd = String(new Date().getDate()).padStart(2, '0');
  // Prefix 'schema-' so the extractSchemas filter (!startsWith('schema-')) correctly
  // excludes approved schemas from future re-clustering after promotion to content_type='text'.
  const snapshotName = `schema-${dominantTopic}-${mm}${dd}`;

  const summary = `Schema cluster (${cluster.length} episodes): ${topics.slice(0, 5).join(', ')}`;

  // Initial edges point to every episode with weight proportional to rank
  const outgoingEdges: MemoryFull['outgoingEdges'] = {};
  const incomingEdges: MemoryFull['incomingEdges'] = {};
  for (const m of cluster) {
    const edgeWeight = Math.min(1.0, 0.5 + m.rank);
    const edge = {
      weight: edgeWeight,
      coRetrievalCount: 0,
      lastReinforcedTurn: currentTurn,
      lastReinforcedAt: now,
      invalidationCount: 0,
      lastInvalidatedTurn: null,
    };
    outgoingEdges[m.id] = edge;
    // reverse pointer on episode
    m.incomingEdges[snapshotName] = edge;
  }

  return {
    id: generateUUID(),
    snapshotName,
    summary,
    title: snapshotName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    transcript: '',
    embedding,
    topics,
    projectPath: cluster[0].projectPath,
    sourceUri: null,
    tokenCount: 0,
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: now,
    createdAtTurn: currentTurn,
    createdAt: now,
    outgoingEdges,
    incomingEdges,
    rank: 1 / Object.keys(cluster).length,
    rankUpdatedAtTurn: currentTurn,
  };
}

export async function extractSchemas(
  graph: MemoryGraph<MemoryFull>,
  _config: JohnnyConfig,
  currentTurn: number,
): Promise<SchemaExtractionResult> {
  const memories = Object.values(graph.memories);

  // Skip memories that ARE already schemas to avoid re-clustering them
  const episodes = memories.filter(m => !m.snapshotName.startsWith('schema-'));
  if (episodes.length < MIN_CLUSTER) return { schemasCreated: 0 };

  const clusters = clusterMemories(episodes);
  let schemasCreated = 0;

  for (const cluster of clusters) {
    // Don't create a schema if one already covers the same dominant topic
    const dominantTopic = Object.entries(
      cluster.flatMap(m => m.topics).reduce<Record<string, number>>((acc, t) => {
        acc[t] = (acc[t] ?? 0) + 1; return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'schema';

    const cleanTopic = dominantTopic.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    const dd = String(new Date().getDate()).padStart(2, '0');
    const todayName = `schema-${cleanTopic}-${mm}${dd}`;
    const topicPrefix = `schema-${cleanTopic}-`;
    // In-memory check first: approved schemas (content_type='text') are loaded into the
    // graph with their schema-prefixed names. Quarantined schemas are excluded from graph
    // load, so they're caught by the DB check below.
    if (Object.values(graph.memories).some(m => m.snapshotName.startsWith(topicPrefix))) continue;
    const existing = await findMemoryBySnapshot(todayName);
    if (existing) continue;

    const schema = buildSchemaMemory(cluster, currentTurn);

    // Persist to DB with contentType='schema' — quarantined until `johnny schemas approve`.
    // Use DB modules directly (not addMemory facade) so the averaged embedding persists.
    // Without embeddings, approved schemas can't participate in cosine similarity recall.
    const persistedId = await memoriesDb.createMemory({
      snapshotName: schema.snapshotName,
      title: schema.title,
      summary: schema.summary ?? '',
      contentType: 'schema',
      projectPath: schema.projectPath ?? '',
      tokenCount: 0,
      createdAtTurn: currentTurn,
    });
    await transcriptsDb.createTranscript({
      memoryId: persistedId,
      transcript: `schema cluster: ${cluster.map(m => m.snapshotName).join(', ')}`,
      topics: schema.topics,
      embedding: schema.embedding ?? undefined,
    });
    const persisted = { id: persistedId };

    // Update in-memory graph so subsequent sleep-phase steps see the new node.
    graph.memories[persisted.id] = { ...schema, id: persisted.id };
    schemasCreated++;
  }

  if (schemasCreated > 0) {
    await log(`sleep/schema-extraction: created ${schemasCreated} schema(s) from ${episodes.length} episodes (quarantined — inspect with johnny schemas)`);
  }

  return { schemasCreated };
}
