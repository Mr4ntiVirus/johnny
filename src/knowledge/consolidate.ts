// Observation consolidation: new facts -> create / update / supersede / retire
// observations. Claude proposes (tool-less, JSON ops with short ids); this
// module validates and applies. Nothing is ever deleted: contradicted or
// obsolete observations keep their row (status superseded/retired + history).

import { query } from '../store/db-client.js';
import { embed, getEmbedModelName } from '../utils/llm.js';
import { cosine } from '../engine/embedder.js';
import * as factsDb from '../store/db/facts.js';
import * as obsDb from '../store/db/observations.js';
import * as modelsDb from '../store/db/mental-models.js';
import * as jobs from '../store/db/jobs.js';
import type { Synthesizer } from './synth.js';
import { extractJsonObject, SynthError } from './synth.js';
import { CONSOLIDATE_SYSTEM, CONSOLIDATOR_VERSION, buildConsolidatePrompt } from './prompts.js';
import { validateOps, isSafeNearDuplicate, type ValidOp, type ValidationContext } from './validate.js';
import { redactSecrets } from './redact.js';
import { BudgetStop } from './governor.js';

export const CONSOLIDATE_JOB = 'consolidate';
export const NEAR_DUP_COSINE = 0.97;
const MAX_FACTS_PER_CALL = 24;
const MAX_CANDIDATE_OBS = 14;

export interface ConsolidatePacket {
  scope: string;
  facts: Array<{ short: string; rec: factsDb.FactRecord }>;
  observations: Array<{ short: string; rec: obsDb.ObservationRecord }>;
  /** watermark value to store once this packet is consumed ("created_at|id" of the last fact). */
  nextWatermark: string;
}

export interface ConsolidateStats {
  scope: string;
  factsConsidered: number;
  created: number;
  updated: number;
  superseded: number;
  retired: number;
  mergedAsDuplicate: number;
  rejected: number;
  rejectReasons: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  changedObservationIds: string[];
}

const emptyStats = (scope: string): ConsolidateStats => ({
  scope, factsConsidered: 0, created: 0, updated: 0, superseded: 0, retired: 0, mergedAsDuplicate: 0,
  rejected: 0, rejectReasons: {}, inputTokens: 0, outputTokens: 0, changedObservationIds: [],
});

const parseWatermark = (w: string | null): { at: string; id: string } =>
  w && w.includes('|') ? { at: w.split('|')[0], id: w.split('|').slice(1).join('|') } : { at: '', id: '' };

/** Scopes that have facts newer than their consolidate watermark. */
export async function scopesWithPendingFacts(): Promise<string[]> {
  const scopes = await query<{ scope: string }>(`SELECT DISTINCT scope FROM facts WHERE status = 'active'`);
  const out: string[] = [];
  for (const { scope } of scopes) {
    const j = await jobs.getJob(CONSOLIDATE_JOB, scope);
    if (j?.paused) continue;
    const wm = parseWatermark(j?.watermark ?? null);
    const r = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM facts WHERE scope = ? AND status = 'active'
         AND (created_at > ? OR (created_at = ? AND id > ?))`, [scope, wm.at, wm.at, wm.id]);
    if ((Number(r[0]?.n) || 0) > 0) out.push(scope);
  }
  return out;
}

export async function buildConsolidatePacket(scope: string): Promise<ConsolidatePacket | null> {
  const j = await jobs.getJob(CONSOLIDATE_JOB, scope);
  const wm = parseWatermark(j?.watermark ?? null);
  const facts = await query<factsDb.FactRecord>(
    `SELECT * FROM facts WHERE scope = ? AND status = 'active'
       AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    [scope, wm.at, wm.at, wm.id, MAX_FACTS_PER_CALL]);
  if (facts.length === 0) return null;

  // Candidate observations: embedding neighbours of any new fact + entity overlap.
  const active = await obsDb.listObservationsInScope(scope);
  const picked = new Map<string, obsDb.ObservationRecord>();
  const scoredBy = new Map<string, number>();
  for (const f of facts) {
    let v = factsDb.factEmbedding(f);
    if (!v) { try { v = await embed(f.text); } catch { v = null; } }
    if (!v) continue;
    for (const o of active) {
      const ov = obsDb.observationEmbedding(o);
      if (!ov || ov.length !== v.length) continue;
      const s = cosine(v, ov);
      if (s > (scoredBy.get(o.id) ?? -1)) scoredBy.set(o.id, s);
    }
  }
  [...scoredBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATE_OBS).forEach(([id]) => {
    const o = active.find(x => x.id === id);
    if (o) picked.set(id, o);
  });
  // Entity overlap (cheap, catches same-subject observations embeddings miss).
  const entities = new Set<string>();
  for (const f of facts) for (const e of await factsDb.getFactEntities(f.id)) entities.add(e);
  if (entities.size > 0) {
    const ents = [...entities].slice(0, 40);
    const rows = await query<{ observation_id: string }>(
      `SELECT DISTINCT ev.observation_id FROM observation_evidence ev
       JOIN fact_entities fe ON fe.fact_id = ev.fact_id
       WHERE fe.entity_norm IN (${ents.map(() => '?').join(',')}) LIMIT 40`, ents);
    for (const r of rows) {
      if (picked.size >= MAX_CANDIDATE_OBS) break;
      const o = active.find(x => x.id === r.observation_id);
      if (o) picked.set(o.id, o);
    }
  }

  const last = facts[facts.length - 1];
  return {
    scope,
    facts: facts.map((rec, i) => ({ short: `F${i + 1}`, rec })),
    observations: [...picked.values()].map((rec, i) => ({ short: `O${i + 1}`, rec })),
    nextWatermark: `${last.created_at}|${last.id}`,
  };
}

function contextFor(packet: ConsolidatePacket): ValidationContext {
  return {
    facts: new Map(packet.facts.map(f => [f.short, {
      text: f.rec.text, quote: f.rec.source_quote,
      dateText: `${f.rec.mentioned_at ?? ''} ${f.rec.occurred_start ?? ''} ${f.rec.created_at}`,
    }])),
    observations: new Map(packet.observations.map(o => [o.short, { text: o.rec.text }])),
  };
}

async function embedText(text: string): Promise<number[] | null> {
  try { return await embed(text); } catch { return null; }
}

async function attachEvidence(obsId: string, packet: ConsolidatePacket, refs: string[], role: 'supports' | 'contradicts' = 'supports'): Promise<void> {
  for (const ref of refs) {
    const f = packet.facts.find(x => x.short === ref);
    if (f) await obsDb.addEvidence(obsId, f.rec.id, f.rec.source_quote, role);
  }
  await obsDb.recomputeProof(obsId);
}

/** Find an existing active observation in scope that is a safe near-duplicate of `text`. */
async function findNearDuplicate(scope: string, text: string, vec: number[] | null): Promise<string | null> {
  if (!vec) return null;
  const active = await obsDb.listObservationsInScope(scope);
  for (const o of active) {
    const ov = obsDb.observationEmbedding(o);
    if (!ov || ov.length !== vec.length) continue;
    if (cosine(vec, ov) >= NEAR_DUP_COSINE && isSafeNearDuplicate(text, o.text)) return o.id;
  }
  return null;
}

export async function applyOps(packet: ConsolidatePacket, ops: ValidOp[], stats: ConsolidateStats): Promise<void> {
  const model = getEmbedModelName();
  const changed = new Set<string>();
  for (const op of ops) {
    const obsRec = op.obsRef ? packet.observations.find(o => o.short === op.obsRef)?.rec ?? null : null;
    const text = redactSecrets(op.text);

    if (op.op === 'create') {
      const vec = await embedText(text);
      const dup = await findNearDuplicate(packet.scope, text, vec);
      if (dup) {
        await attachEvidence(dup, packet, op.factRefs);
        stats.mergedAsDuplicate++;
        changed.add(dup);
        continue;
      }
      const id = await obsDb.createObservation({
        scope: packet.scope, text, facet: op.facet, subject: op.subject,
        embedding: vec, embeddingModel: vec ? model : null, consolidatorVersion: CONSOLIDATOR_VERSION,
      }, op.reason);
      await attachEvidence(id, packet, op.factRefs);
      stats.created++;
      changed.add(id);
    } else if (op.op === 'update' && obsRec) {
      const vec = await embedText(text);
      await obsDb.updateObservationText(obsRec.id, text, op.reason, vec, vec ? model : null);
      await attachEvidence(obsRec.id, packet, op.factRefs);
      stats.updated++;
      changed.add(obsRec.id);
    } else if (op.op === 'supersede' && obsRec) {
      const vec = await embedText(text);
      const successor = await obsDb.createObservation({
        scope: packet.scope, text, facet: op.facet ?? obsRec.facet, subject: op.subject ?? obsRec.subject,
        embedding: vec, embeddingModel: vec ? model : null, consolidatorVersion: CONSOLIDATOR_VERSION,
      }, `supersedes earlier belief: ${op.reason}`);
      await attachEvidence(successor, packet, op.factRefs);
      await attachEvidence(obsRec.id, packet, op.factRefs, 'contradicts');
      await obsDb.supersedeObservation(obsRec.id, successor, op.reason);
      stats.superseded++;
      changed.add(successor);
      changed.add(obsRec.id);
    } else if (op.op === 'retire' && obsRec) {
      await obsDb.supersedeObservation(obsRec.id, null, op.reason);
      stats.retired++;
      changed.add(obsRec.id);
    }
  }
  stats.changedObservationIds = [...changed];

  // Any model built on a changed observation is now stale.
  if (changed.size > 0) {
    const models = await modelsDb.listModels({ status: 'active' });
    const stale = models.filter(m => modelsDb.modelBasedOn(m).some(id => changed.has(id))).map(m => m.slug);
    if (stale.length > 0) await modelsDb.forceStale(stale);
  }
}

/** One consolidation pass for a scope. Returns null if nothing to do or the claim was lost. */
export async function consolidateScope(
  synth: Synthesizer, scope: string, owner = `consolidate-${process.pid}`,
): Promise<ConsolidateStats | null> {
  if (!(await jobs.claimJob(CONSOLIDATE_JOB, scope, owner))) return null;
  try {
    const packet = await buildConsolidatePacket(scope);
    if (!packet) { await jobs.setPending(CONSOLIDATE_JOB, scope, false); return null; }

    const stats = emptyStats(scope);
    stats.factsConsidered = packet.facts.length;

    const res = await synth.complete({
      role: 'consolidate', system: CONSOLIDATE_SYSTEM,
      prompt: buildConsolidatePrompt(
        scope,
        packet.facts.map(f => ({
          id: f.short, kind: f.rec.kind, date: f.rec.mentioned_at ?? f.rec.created_at,
          text: f.rec.text, session: f.rec.session_id ?? '',
        })),
        packet.observations.map(o => ({ id: o.short, text: o.rec.text, proof: o.rec.proof_count }))),
    });
    stats.inputTokens = res.inputTokens;
    stats.outputTokens = res.outputTokens;

    const parsed = extractJsonObject(res.text) as { ops?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.ops)) throw new Error('consolidate: model returned unparseable output');

    const { ops, rejected } = validateOps(parsed.ops, contextFor(packet));
    stats.rejected = rejected.length;
    for (const r of rejected) {
      const key = r.reason.split(':')[0];
      stats.rejectReasons[key] = (stats.rejectReasons[key] ?? 0) + 1;
    }
    await applyOps(packet, ops, stats);

    // Facts are consumed even when the model made no/invalid ops: the validators
    // are the quality gate, and re-sending the same facts forever would starve the queue.
    await jobs.setWatermark(CONSOLIDATE_JOB, scope, packet.nextWatermark);
    await jobs.recordStats(CONSOLIDATE_JOB, scope, { ...stats, at: new Date().toISOString() });
    await jobs.recordSuccess(CONSOLIDATE_JOB, scope);
    const more = (await scopesWithPendingFacts()).includes(scope);
    await jobs.setPending(CONSOLIDATE_JOB, scope, more);
    return stats;
  } catch (err) {
    // Infrastructure errors (timeout, CLI crash) are transient and must not count toward pausing.
    if (!(err instanceof SynthError) && !(err instanceof BudgetStop)) await jobs.recordFailure(CONSOLIDATE_JOB, scope, String(err));
    throw err;
  } finally {
    await jobs.releaseJob(CONSOLIDATE_JOB, scope, owner);
  }
}
