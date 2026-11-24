// Offer — the cheapest emission band on the Phase G two-trigger ladder.
//
// Fires when the matched candidate's similarity is in [offerThreshold, high)
// — meaningful but below the recommend_memory bar. Emits a hint-only Form 1 block
// on additionalContext (titles + topics + call instructions) without any
// JSONL surgery or body load. Claude can pull excerpts via johnny_recall if
// the offer turns out to actually matter.
//
// Cooldown filtering applies: a memory in cooldown (recent surface AND
// similarity below subjectShiftThreshold) is held back. If the matched
// memory is held, the action returns an empty output — Johnny stays silent
// rather than re-spamming the same hint.

import { formatHint, type ScoredMemory } from '../engine/hint.js';
import { isInCooldown } from '../engine/cooldown.js';
import { getSurfacedMap, setMemorySurfaced } from '../store/db/sessions.js';
import { logHintEmission } from '../store/db/telemetry.js';
import { touchMemory } from '../store/memory.js';
import type { MemoryNode, HookOutput, JohnnyConfig } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';
import { humanDate } from '../utils/human-date.js';

// Classifier's strong-match threshold — anything ≥ this would have triggered
// recommend_memory upstream, so the offer band's high cutoff is implicit. Setting
// it equal to 1 in the formatter keeps Form 3 from firing inside an offer.
const OFFER_HIGH_THRESHOLD = 1;

export async function offer(
  matchedMemory: MemoryNode,
  topSimilarity: number,
  sessionId: string,
  currentTurn: number,
  config: JohnnyConfig,
): Promise<HookOutput> {
  const surfacedMap = await getSurfacedMap(sessionId);

  if (
    isInCooldown(
      matchedMemory.id,
      topSimilarity,
      { surfacedMap, currentTurn },
      { cooldownTurns: config.cooldownTurns, subjectShiftThreshold: config.subjectShiftThreshold },
    )
  ) {
    await log(`offer: ${matchedMemory.snapshotName} held (cooldown)`);
    return {};
  }

  const scored: ScoredMemory[] = [{ memory: matchedMemory, score: topSimilarity }];
  const emission = formatHint(scored, {
    highThreshold: OFFER_HIGH_THRESHOLD,
    normalThreshold: config.offerThreshold,
    maxMemories: 1,
  });

  if (!emission) {
    // Score fell below offerThreshold between decide() and here — silent.
    await log(`offer: ${matchedMemory.snapshotName} formatter returned null`);
    return {};
  }

  await setMemorySurfaced(sessionId, matchedMemory.id, currentTurn);

  // Touch retrieval bookkeeping only when the surface actually ships. A
  // cooldown-suppressed offer must stay invisible to the graph — otherwise
  // dormancy / Hebbian reinforcement would treat the memory as retrieved
  // even though Claude never saw the hint.
  await touchMemory(matchedMemory.id, currentTurn, config);

  logHintEmission({
    sessionId,
    form: 'offer',
    suggestedMemoryIds: emission.surfacedMemoryIds,
    topScore: topSimilarity,
    threshold: config.offerThreshold,
    tokenEstimate: Math.ceil(emission.text.length / 4),
  });

  await log(`offer: ${matchedMemory.snapshotName} (sim=${topSimilarity.toFixed(2)})`);

  return {
    additionalContext: emission.text,
    systemMessage:
      neon.cyan('◇') +
      ink.fg(`  ${humanDate(matchedMemory.createdAt)}`) +
      dim.fg(` · ${matchedMemory.topics.slice(0, 2).join('/')} (${Math.round(topSimilarity * 100)}%)`),
  };
}
