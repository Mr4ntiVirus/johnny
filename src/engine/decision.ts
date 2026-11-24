import type { DecisionContext, Action } from '../types.js';
import { RECOMMEND_THRESHOLD, OFFER_THRESHOLD, MIN_HINT_COSINE, MIN_SWITCH_HINT_COSINE } from './scorer.js';

/** Raw-cosine tier for a memory hint: 'full' (>= 0.75), 'light' (topic switch, >= 0.65: digest only), else 'none'. */
export function hintTier(embeddingScore: number, isTopicSwitch: boolean): 'full' | 'light' | 'none' {
  if (embeddingScore >= MIN_HINT_COSINE) return 'full';
  if (isTopicSwitch && embeddingScore >= MIN_SWITCH_HINT_COSINE) return 'light';
  return 'none';
}

// Trim is context hygiene fired exclusively from post-turn (PostToolUse) with
// its own cooldown — not a decision returned here.

export function decide(ctx: DecisionContext): Action {
  const { recallScore, embeddingScore, isAmbiguous, isTopicSwitch, contextPressure } = ctx;
  // Weak raw match: hide every memory hint (the boosted recallScore may still clear the thresholds below).
  // embeddingScore 0 = embedder offline, a keyword-only match has no semantic grounding either.
  const tier = hintTier(embeddingScore, isTopicSwitch);
  const weak = tier === 'none';
  const matchedMemory = weak ? null : ctx.matchedMemory;
  const candidates = weak ? [] : ctx.candidates;

  // Gate 1: LLM confirmed prompt is distant from current session context.
  // Act regardless of context pressure — the user is moving on.
  if (isTopicSwitch) {
    if (matchedMemory && recallScore >= OFFER_THRESHOLD) {
      // Light tier: the match is plausible but not strong → digest only (offer), never a transcript append.
      if (tier === 'light') return 'offer';
      return recallScore >= RECOMMEND_THRESHOLD
        ? 'hard_switch'            // strong memory match → clear + load (demoted by gateHardSwitch unless enabled)
        : 'recommend_memory';      // moderate match → gentle load, keep session
    }
    // no match → fall through. A negative signal alone never destructively
    // resets context; a high-pressure session still gets snapshotted below.
  }
  // A light-tier match is only for the switch gate above; the generic branches need the full floor.
  if (tier === 'light') return contextPressure >= 70 ? 'snapshot_passthrough' : 'passthrough';

  if (recallScore >= RECOMMEND_THRESHOLD && matchedMemory) {
    return contextPressure >= 50 ? 'hard_switch' : 'recommend_memory';
  }
  if (isAmbiguous && candidates.length >= 2 && recallScore >= OFFER_THRESHOLD) {
    return 'suggest_memories';
  }
  if (recallScore >= OFFER_THRESHOLD && matchedMemory) {
    return 'offer';
  }
  if (contextPressure >= 70) {
    return 'snapshot_passthrough';
  }
  return 'passthrough';
}
