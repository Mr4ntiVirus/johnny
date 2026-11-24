// Verifier pass for extracted facts: a second, independent model prompt checks a
// random sample of newly extracted facts against their source window. Unsupported
// facts are disputed (excluded from consolidation and recall). The unsupported
// RATE across runs is the auto-pause signal for the extraction step.

import type { Synthesizer } from './synth.js';
import { extractJsonObject } from './synth.js';
import { VERIFY_SYSTEM, buildVerifyFactsPrompt } from './prompts.js';
import { disputeFact } from '../store/db/facts.js';
import type { ExtractStats } from './extract.js';

const PER_CALL = 8;
const MAX_WINDOW_CHARS = 5200;

export interface VerifyResult { checked: number; unsupported: number; inputTokens: number; outputTokens: number }

/** Deterministic-capable sampler (inject rng for tests). */
export function sampleFacts<T>(items: T[], rate: number, rng: () => number = Math.random): T[] {
  if (items.length === 0 || rate <= 0) return [];
  const picked = items.filter(() => rng() < rate);
  // Always check at least one fact from a non-trivial batch.
  if (picked.length === 0 && items.length >= 5) picked.push(items[Math.floor(rng() * items.length)]);
  return picked;
}

export async function verifyFactSample(
  synth: Synthesizer, created: ExtractStats['created'], rate: number, rng: () => number = Math.random,
): Promise<VerifyResult> {
  const sample = sampleFacts(created, rate, rng);
  const out: VerifyResult = { checked: 0, unsupported: 0, inputTokens: 0, outputTokens: 0 };
  for (let i = 0; i < sample.length; i += PER_CALL) {
    const slice = sample.slice(i, i + PER_CALL);
    const ids = new Map(slice.map((f, k) => [`V${i + k + 1}`, f]));
    const res = await synth.complete({
      role: 'verify', system: VERIFY_SYSTEM,
      prompt: buildVerifyFactsPrompt([...ids].map(([id, f]) => ({
        id, text: f.text, quote: f.quote, window: f.windowText.slice(0, MAX_WINDOW_CHARS),
      }))),
    });
    out.inputTokens += res.inputTokens; out.outputTokens += res.outputTokens;
    const parsed = extractJsonObject(res.text) as { verdicts?: Array<{ id?: unknown; supported?: unknown }> } | null;
    if (!parsed || !Array.isArray(parsed.verdicts)) continue; // unparseable verifier: don't punish the facts
    for (const v of parsed.verdicts) {
      const f = typeof v.id === 'string' ? ids.get(v.id) : undefined;
      if (!f || typeof v.supported !== 'boolean') continue;
      out.checked++;
      if (!v.supported) { out.unsupported++; await disputeFact(f.id); }
    }
  }
  return out;
}
