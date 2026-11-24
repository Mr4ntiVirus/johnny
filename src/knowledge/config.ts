import type { KnowledgeConfig } from '../types.js';
import { readConfig } from '../store/config.js';

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  prime: true, // compiled knowledge is injected automatically; set false to turn priming off
  primeMinSimilarity: 0.70,
  primeContinuationSimilarity: 0.75,
  primeToolSimilarity: 0.53,
  primeMaxChars: 1200,
  primeMinProof: 2,
  retireSearchNudge: true,
  legacyHints: true, // Johnny's per-turn hints are its primary recall trigger; the output-format fix restores them
  synth: {
    defaultModel: 'sonnet',
    models: {},
    maxCallsPerRun: 80,
    maxCallsPerDay: 400,
    maxTokensPerRun: 1_500_000,
    timeBoxMinutes: 75,
    memoriesPerBatch: 12,
    maxMemoriesPerRun: 240,
    windowsPerCall: 8,
    concurrency: 3,
    verifySampleRate: 0.1,
    pauseRejectRate: 0.5,
  },
};

export async function readKnowledgeConfig(): Promise<KnowledgeConfig> {
  const saved = (await readConfig()).knowledge ?? {};
  // Per-process override for verification through a real client (`JOHNNY_KNOWLEDGE_PRIME=1 claude -p ...`)
  // without flipping the global switch for every live session. "0" forces it off.
  const envPrime = process.env.JOHNNY_KNOWLEDGE_PRIME;
  if (envPrime === '1' || envPrime === '0') saved.prime = envPrime === '1';
  return {
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...saved,
    synth: {
      ...DEFAULT_KNOWLEDGE_CONFIG.synth,
      ...(saved.synth ?? {}),
      models: { ...DEFAULT_KNOWLEDGE_CONFIG.synth.models, ...(saved.synth?.models ?? {}) },
    },
  };
}
