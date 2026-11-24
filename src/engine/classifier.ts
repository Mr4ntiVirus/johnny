import { classify, isOllamaOnline } from '../utils/llm.js';
import { rankBySimilarity } from './embedder.js';
import type { MemoryNode } from '../types.js';
import { log } from '../utils/log.js';
import { RECOMMEND_THRESHOLD, OFFER_THRESHOLD } from './scorer.js';

// Ambiguous band: top two embeddings are within this margin of each other.
const AMBIGUOUS_BAND = 0.08;

export interface ClassifierSignals<T extends MemoryNode = MemoryNode> {
  embeddingScore: number;         // cosine similarity of best match (0 when embedder offline/failed)
  matchedMemory: T | null;
  candidates: T[];
  isAmbiguous: boolean;
  llmVote: 'switch' | 'new' | 'continue' | null;  // null when LLM offline, not needed, or abstained
  rawLabel: string | null;        // raw classify() label, for diagnostics — null if LLM wasn't called/failed
  source: 'embedding' | 'llm' | 'offline'; // diagnostic
  // True only when rankBySimilarity() threw (embedder infra error, e.g. Ollama 500) —
  // distinct from a genuine zero-similarity result. embeddingScore still falls back to
  // 0 either way (same downstream shape), but callers that would otherwise let an
  // unconfirmed llmVote drive a topic switch should treat this turn's vote as
  // unreliable rather than trusting it the way they'd trust a vote backed by a real
  // (even if low) embedding score.
  embedderFailed: boolean;
}

export async function runClassifier<T extends MemoryNode>(
  prompt: string,
  memories: T[],
  currentSummary: string,
): Promise<ClassifierSignals<T>> {
  if (memories.length === 0) {
    return { embeddingScore: 0, matchedMemory: null, candidates: [], isAmbiguous: false, llmVote: null, rawLabel: null, source: 'offline', embedderFailed: false };
  }

  // Step 1: embedding similarity
  let scored: { memory: T; similarity: number }[] = [];
  let embedderFailed = false;
  try {
    scored = await rankBySimilarity(prompt, memories, 5);
  } catch (err) {
    embedderFailed = true;
    await log(`embedder error: ${err}`);
  }

  const best = scored[0];
  const second = scored[1];
  const embeddingScore = best?.similarity ?? 0;

  const isAmbiguous = !!(
    best && second &&
    (best.similarity - second.similarity) < AMBIGUOUS_BAND &&
    best.similarity >= OFFER_THRESHOLD
  );

  // Step 2: LLM vote — run whenever there's prior session context to compare against
  // and the embedding score hasn't already hit the high-confidence memory-match threshold.
  // Extended below OFFER_THRESHOLD so explicit topic switches with no memory match
  // (embeddingScore near 0) are still detected; capped at RECOMMEND_THRESHOLD because
  // above that the match is already decisive and the LLM dampen would incorrectly
  // suppress high-confidence recall.
  let llmVote: 'switch' | 'new' | 'continue' | null = null;
  let rawLabel: string | null = null;
  const inLlmBand = embeddingScore < RECOMMEND_THRESHOLD;

  if (inLlmBand && currentSummary) {
    const online = await isOllamaOnline();
    if (online) {
      try {
        const label = await classify(prompt, currentSummary);
        rawLabel = label;
        if (label === 'topic_switch') llmVote = 'switch';
        else if (label === 'new_topic') llmVote = 'new';
        else if (label === 'continuation') llmVote = 'continue';
        // 'ambiguous' (incl. the parse-failure fallback in llm.ts): llmVote stays
        // null — the LLM abstains rather than asserting a topic switch on a
        // low-confidence signal. isTopicSwitch then depends only on a confident
        // 'new_topic'/'topic_switch' vote or hSignals.isNewTopic.
      } catch (err) {
        await log(`classifier LLM error: ${err}`);
      }
    }
  }

  return {
    embeddingScore,
    matchedMemory: best?.memory ?? null,
    candidates: scored.slice(0, 2).map(s => s.memory),
    isAmbiguous,
    llmVote,
    rawLabel,
    source: llmVote !== null ? 'llm' : embeddingScore > 0 ? 'embedding' : 'offline',
    embedderFailed,
  };
}
