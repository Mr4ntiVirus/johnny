// Single-gate recall scoring. Merges keyword overlap (heuristics), embedding
// cosine similarity (classifier), context signals (cwd change, time gap), and
// LLM vote into one continuous recallScore in [0,1].
//
// The single gate: recallScore >= threshold → action fires.
// The depth: any combination of signals can push score over threshold.

import type { MemoryNode } from '../types.js';

// Calibrated 2026-05-06 against 125 embedded memories in live DB:
//   generic Johnny prompts:       0.54–0.57  → should not fire recall
//   on-topic but vague prompts:   0.60–0.62  → offer territory (with LLM_SWITCH_BOOST: 0.75–0.77)
//   genuinely specific prompts:   0.71–0.74  → recommend territory
// 2026-06-26: fixed llmVote='new' not getting LLM_SWITCH_BOOST (same as 'switch').
//   Session 132ffcda had 0 recalls despite llmVote=new on turns 3+6 at scores 0.51/0.59.
const KEYWORD_WEIGHT = 0.5;        // keyword-only contribution cap (when embedder offline)
const CWD_BOOST = 1.30;            // strong context signal: switched project directories
const GAP_BOOST = 1.10;            // mild signal: long idle gap before this prompt
const LLM_SWITCH_BOOST = 0.15;     // LLM confirmed topic switch → push borderline over threshold
const LLM_CONTINUE_DAMPEN = 0.80;  // LLM said "stay on current topic" → suppress false-positive recall

export const RECOMMEND_THRESHOLD = 0.70;  // exported so tests can stay in sync
export const OFFER_THRESHOLD = 0.62;
// Raw-cosine floor for ANY memory hint (recommend/offer/suggest). The boosted score is a routing signal, not
// evidence that this memory fits: an LLM 'new topic' vote adds +0.15, so a vague 0.62 match reached 0.77.
// 2026-10-13 `johnny eval-recommend` on real hints: 2/21 helpful overall, 1/9 in the 0.70-0.75 band, 1/3 at
// 0.75+. Hide anything below this floor; a missed hint is recoverable via johnny_recall, a wrong one teaches
// the model to ignore every hint. Re-tune with eval-recommend as labels accumulate.
export const MIN_HINT_COSINE = 0.75;
// Topic-switch turns get a LOWER floor but only a LIGHT hint (see decide()): a prompt that reads as a new
// topic has a low raw cosine by nature (68 replayed switch turns: raw 0.45-0.70, none >= 0.75, so the 0.75
// floor silenced the whole path). 2026-10-14: a switch with a matching memory should get recall. The
// light hint is `offer` (digest only, no transcript append), so a wrong match costs a few lines, not a session.
export const MIN_SWITCH_HINT_COSINE = 0.65;
// embeddingScore=0 means Ollama is offline — keyword-only signal lacks semantic grounding.
// Cap just below RECOMMEND_THRESHOLD so hard_switch can never fire on a degraded signal;
// non-destructive actions (recommend_memory/offer/suggest) still fire via OFFER_THRESHOLD.
const EMBEDDER_OFFLINE_CAP = RECOMMEND_THRESHOLD - 0.01;

export interface RecallScore {
  score: number;            // composite 0-1 — the single routing gate
  embeddingScore: number;   // raw cosine before boosts — passed to offer() for cooldown + display %
  matchedMemory: MemoryNode | null;
  candidates: MemoryNode[];
  isAmbiguous: boolean;
  isNewTopic: boolean;
}

export function computeScore(
  keywordScore: number,
  embeddingScore: number,
  matchedMemory: MemoryNode | null,
  candidates: MemoryNode[],
  isAmbiguous: boolean,
  isNewTopic: boolean,
  signals: { cwdChanged: boolean; longGap: boolean },
  llmVote: 'switch' | 'new' | 'continue' | null,
): RecallScore {
  // Embedding dominates; keyword lifts when embedder is offline (embeddingScore=0).
  const base = Math.max(embeddingScore, keywordScore * KEYWORD_WEIGHT);
  const contextBoost = (signals.cwdChanged && !isNewTopic) ? CWD_BOOST
                     : signals.longGap ? GAP_BOOST
                     : 1.0;
  // LLM 'continue' dampens first (scale), then 'switch'/'new' adds (addend). This
  // ordering means a switch boost cannot fully cancel a 'continue' dampen —
  // the LLM must agree on direction for a borderline case to fire recall.
  // 'new' and 'switch' both signal a topic change (decide() treats them identically);
  // both should boost the score symmetrically. The pre-2026-06-26 code only boosted
  // 'switch', leaving 'new_topic' votes with no lift — turns with score 0.51–0.59
  // and llmVote='new' fell through to passthrough even when recall should have fired.
  const llmFactor = llmVote === 'continue' ? LLM_CONTINUE_DAMPEN : 1.0;
  const llmAddend = (llmVote === 'switch' || llmVote === 'new') ? LLM_SWITCH_BOOST : 0;
  let score = Math.min(1, base * contextBoost * llmFactor + llmAddend);
  if (embeddingScore === 0) {
    score = Math.min(score, EMBEDDER_OFFLINE_CAP);
  }

  return { score, embeddingScore, matchedMemory, candidates, isAmbiguous, isNewTopic };
}
