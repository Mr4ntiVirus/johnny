import type { JohnnyConfig } from '../types.js';
import { readJsonFile } from '../utils/jsonl.js';
import { PATHS } from './paths.js';

export const DEFAULT_CONFIG: JohnnyConfig = {
  reinforcementDelta: 1.0,
  invalidationLambda: 2.0,
  activationTau: 500,
  pageRankDamping: 0.85,
  topKOutgoing: 50,
  rankRefreshEveryTurns: 10,
  pruneLiftFloor: 0.05,
  pruneTrustFloor: 0.1,
  pruneDormancyTurns: 2000,  // was 10000 — unreachable at production turn~320 (Fix 2.2)
  similarityAlpha: 0.5,
  similarityBeta: 0.5,
  similarityGamma: 0.3,
  similarityDelta: 0.7,
  intentGapMinutes: 30,
  snapshotNoveltyThreshold: 0.78,
  derivedFromInitialWeight: 1.0,
  cooldownTurns: 6,
  subjectShiftThreshold: 0.78,
  offerThreshold: 0.62,
  contextLimitTokens: 1_000_000,
  mcpRecallReinforcementDelta: 0.5,
  mcpRecallMaxCoReinforce: 6,
  minSkillClusterScore: 0.15,
  minSkillClusterSize: 3,
};

export async function readConfig(): Promise<JohnnyConfig> {
  const saved = await readJsonFile<Partial<JohnnyConfig>>(PATHS.config);
  return { ...DEFAULT_CONFIG, ...(saved ?? {}) };
}
