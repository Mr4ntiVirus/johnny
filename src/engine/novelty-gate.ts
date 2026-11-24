// Semantic-novelty gate: block snapshot creation when the candidate summary
// is too similar to the session's most recent prior snapshot. Ships lenient
// by design — sleep-phase schema-extraction clusters over-capture later.
// Tuned end-of-project via the smell-test harness (task #28).

import { embed } from '../utils/llm.js';
import { cosine } from './embedder.js';
import { getSessionEntry } from '../store/session-map.js';
import { getTranscript } from '../store/db/transcripts.js';
import { getMemory } from '../store/db/memories.js';
import { decodeEmbedding } from '../utils/embedding-codec.js';

export interface NoveltyVerdict {
  redundant: boolean;
  similarity: number;
  priorSnapshotName: string | null;
}

// The gate compares the candidate summary to the session's last snapshot's
// stored embedding. Three skip paths return { redundant: false }:
//   1. Session has never snapshotted → no baseline, always novel.
//   2. Prior memory has no embedding stored → can't compare, assume novel.
//   3. Ollama call fails → fail-open, let the snapshot through.
export async function checkSnapshotNovelty(
  candidateSummary: string,
  sessionId: string,
  threshold: number,
): Promise<NoveltyVerdict> {
  const sessionEntry = await getSessionEntry(sessionId);
  const priorId = sessionEntry?.memoryId ?? null;
  if (!priorId) {
    return { redundant: false, similarity: 0, priorSnapshotName: null };
  }

  const priorTranscript = await getTranscript(priorId);
  if (!priorTranscript?.embedding) {
    return { redundant: false, similarity: 0, priorSnapshotName: null };
  }

  let priorVec: number[];
  try {
    priorVec = decodeEmbedding(priorTranscript.embedding);
  } catch {
    return { redundant: false, similarity: 0, priorSnapshotName: null };
  }

  let candidateVec: number[];
  try {
    candidateVec = await embed(candidateSummary);
  } catch {
    return { redundant: false, similarity: 0, priorSnapshotName: null };
  }

  if (candidateVec.length !== priorVec.length) {
    // Dimension mismatch — stale embedding from a prior model. Treat as novel.
    return { redundant: false, similarity: 0, priorSnapshotName: null };
  }

  const sim = cosine(candidateVec, priorVec);
  const priorMem = await getMemory(priorId);
  return {
    redundant: sim >= threshold,
    similarity: sim,
    priorSnapshotName: priorMem?.snapshot_name ?? null,
  };
}
