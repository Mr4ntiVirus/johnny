import { embed, getEmbedModelName } from '../utils/llm.js';
import { getEmbeddingsByIds, setEmbedding } from '../store/db/transcripts.js';
import type { MemoryNode, MemoryFull } from '../types.js';

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface ScoredMemory<T extends MemoryNode = MemoryNode> {
  memory: T;
  similarity: number;
}

// Embed the prompt and score it against every memory that has an embedding.
// Accepts MemoryNode[] — embeddings are fetched in one batched SELECT so the
// caller can skip readGraphFull() on the hot path. If a caller already has
// MemoryFull[] with `.embedding` populated, that value is used directly.
export async function rankBySimilarity<T extends MemoryNode>(
  prompt: string,
  memories: T[],
  topK = 5,
): Promise<ScoredMemory<T>[]> {
  if (memories.length === 0) return [];

  // Reuse inline embeddings if already on the objects (MemoryFull path).
  const inlineEmbeddings = new Map<string, number[]>();
  const needsLookup: string[] = [];
  for (const m of memories) {
    const emb = (m as Partial<MemoryFull>).embedding;
    if (emb) inlineEmbeddings.set(m.id, emb);
    else needsLookup.push(m.id);
  }
  const fetched = needsLookup.length > 0 ? await getEmbeddingsByIds(needsLookup) : new Map<string, number[]>();
  const embeddings = new Map<string, number[]>([...inlineEmbeddings, ...fetched]);

  if (embeddings.size === 0) return [];

  const promptVec = await embed(prompt);

  return memories
    .filter(m => embeddings.has(m.id))
    .map(m => ({ memory: m, similarity: cosine(promptVec, embeddings.get(m.id)!) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

// Embed a memory summary+topics and persist the vector to the transcripts table.
// Also mutates mem.embedding in-place when given a MemoryFull, so callers can
// use the value without a round-trip read.
export async function embedMemory(mem: MemoryNode | MemoryFull): Promise<void> {
  const text = [mem.summary, ...mem.topics].join(' ');
  const vec = await embed(text);
  await setEmbedding(mem.id, vec, getEmbedModelName());
  if ('embedding' in mem) (mem as MemoryFull).embedding = vec;
}
