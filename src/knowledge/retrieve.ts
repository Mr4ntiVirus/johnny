// Read side of the knowledge layer: ranked search over mental models,
// observations and facts. No LLM — embedding cosine plus Hindsight-style
// recency / proof boosts. Shared by automatic priming (hook) and the
// introspection tools (MCP).
//
// Layer order matters (Hindsight reflect: models -> observations -> facts):
// a small bonus nudges a model above the observations it was built from and an
// observation above a raw fact when they are otherwise tied.

import { cosine } from '../engine/embedder.js';
import * as obsDb from '../store/db/observations.js';
import * as factsDb from '../store/db/facts.js';
import * as modelsDb from '../store/db/mental-models.js';
import { modelIsStale } from './refresh.js';
import { splitSections } from './sections.js';

export type KnowledgeKind = 'model' | 'observation' | 'fact';

export interface KnowledgeHit {
  kind: KnowledgeKind;
  /** Stable tile id: model:<slug> | obs:<id> | fact:<id> */
  ref: string;
  title: string;
  text: string;
  scope: string;
  /** Final ordering score (cosine × boosts × layer bonus). */
  score: number;
  /** Raw cosine similarity. */
  similarity: number;
  /** ISO date the item was last updated/refreshed. */
  asOf: string;
  stale: boolean;
  /** Distinct sessions backing it (observations) / evidence count (models). */
  proof: number;
  /** Provenance, used by priming gates. */
  disputed: boolean;
  verified: boolean;
  /** For models: the section that best matches the query (what priming should show). */
  focus?: string;
}

export const LAYER_BONUS: Record<KnowledgeKind, number> = { model: 0.03, observation: 0.015, fact: 0 };
export const RECENCY_ALPHA = 0.2;
export const PROOF_ALPHA = 0.1;
const RECENCY_WINDOW_DAYS = 365;
const MAX_FACT_CANDIDATES = 15000;

export const boost = (alpha: number, signal01: number): number => 1 + alpha * (signal01 - 0.5);

export function recencySignal(iso: string, nowMs = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return Math.max(0, 1 - ageDays / RECENCY_WINDOW_DAYS);
}

export const proofSignal = (proof: number): number => Math.min(1, Math.log1p(Math.max(0, proof)) / Math.log1p(10));

export interface SearchOptions {
  /** Project scope (git root); 'global' knowledge is always included. Null = every scope. */
  scope?: string | null;
  kinds?: KnowledgeKind[];
  limit?: number;
  minSimilarity?: number;
  /** Compute staleness for model hits (extra queries). */
  withStaleness?: boolean;
}

export async function searchKnowledge(queryVec: number[], opts: SearchOptions = {}): Promise<KnowledgeHit[]> {
  const kinds = new Set(opts.kinds ?? ['model', 'observation', 'fact']);
  const minSim = opts.minSimilarity ?? 0.35;
  const scope = opts.scope ?? null;
  const now = Date.now();
  const hits: KnowledgeHit[] = [];

  if (kinds.has('model')) {
    for (const m of await modelsDb.listModels({ status: 'active', scope: scope ?? undefined, includeWorkspaceChildren: true })) {
      if (!m.content) continue;
      // Match the model's generic title+question AND each of its sections; a specific
      // prompt is answered by one section, so the best section often scores far
      // higher than the whole-model embedding. The matching section becomes the focus.
      const q = modelsDb.modelQueryEmbedding(m);
      let sim = q && q.length === queryVec.length ? cosine(queryVec, q) : -1;
      let focus: string | undefined;
      const svecs = modelsDb.modelSectionEmbeddings(m);
      if (svecs) {
        const sections = splitSections(m.content);
        svecs.forEach((v, i) => {
          if (v.length !== queryVec.length) return;
          const ss = cosine(queryVec, v);
          if (ss > sim) { sim = ss; focus = sections[i]; }
        });
      }
      if (sim < minSim) continue;
      const evidence = modelsDb.modelBasedOn(m).length;
      hits.push({
        kind: 'model', ref: `model:${m.slug}`, title: m.name, text: m.content, scope: m.scope,
        similarity: sim,
        score: sim * boost(RECENCY_ALPHA, recencySignal(m.last_refreshed_at ?? m.updated_at, now)) + LAYER_BONUS.model,
        asOf: m.last_refreshed_at ?? m.updated_at,
        stale: opts.withStaleness ? await modelIsStale(m) : !!m.force_stale,
        proof: evidence, disputed: false, verified: m.paused === 0 && evidence > 0, focus,
      });
    }
  }

  if (kinds.has('observation')) {
    for (const o of await obsDb.listActiveObservations(scope, 4000, true)) {
      const v = obsDb.observationEmbedding(o);
      if (!v || v.length !== queryVec.length) continue;
      const sim = cosine(queryVec, v);
      if (sim < minSim) continue;
      hits.push({
        kind: 'observation', ref: `obs:${o.id}`, title: o.facet ?? o.subject ?? 'observation', text: o.text, scope: o.scope,
        similarity: sim,
        score: sim * boost(PROOF_ALPHA, proofSignal(o.proof_count)) * boost(RECENCY_ALPHA, recencySignal(o.updated_at, now)) + LAYER_BONUS.observation,
        asOf: o.updated_at, stale: false, proof: o.proof_count,
        disputed: o.invalidation_count >= 2, verified: o.review_state !== 'rejected',
      });
    }
  }

  if (kinds.has('fact')) {
    const facts = await factsDb.listActiveFacts(scope, MAX_FACT_CANDIDATES, undefined, true);
    for (const f of facts) {
      const v = factsDb.factEmbedding(f);
      if (!v || v.length !== queryVec.length) continue;
      const sim = cosine(queryVec, v);
      if (sim < minSim) continue;
      hits.push({
        kind: 'fact', ref: `fact:${f.id}`, title: f.kind, text: f.text, scope: f.scope,
        similarity: sim,
        score: sim * boost(RECENCY_ALPHA, recencySignal(f.mentioned_at ?? f.created_at, now)),
        asOf: f.mentioned_at ?? f.created_at, stale: false, proof: 1,
        disputed: f.invalidation_count >= 2, verified: true,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, opts.limit ?? 10);
}

/** Facts/observations behind an observation or model, for introspection (`johnny_reflect`). */
export async function evidenceFor(ref: string): Promise<Array<{ kind: 'observation' | 'fact'; id: string; text: string; quote: string | null }>> {
  if (ref.startsWith('obs:')) {
    const ev = await obsDb.getEvidence(ref.slice(4));
    const facts = await factsDb.getFacts(ev.map(e => e.fact_id));
    const byId = new Map(facts.map(f => [f.id, f]));
    return ev.map(e => ({ kind: 'fact' as const, id: e.fact_id, text: byId.get(e.fact_id)?.text ?? '(fact removed)', quote: e.quote }));
  }
  if (ref.startsWith('model:')) {
    const m = await modelsDb.getModelBySlug(ref.slice(6));
    if (!m) return [];
    const ids = modelsDb.modelBasedOn(m);
    const obs = await obsDb.getObservations(ids);
    const facts = await factsDb.getFacts(ids);
    return [
      ...obs.map(o => ({ kind: 'observation' as const, id: o.id, text: o.text, quote: null })),
      ...facts.map(f => ({ kind: 'fact' as const, id: f.id, text: f.text, quote: f.source_quote })),
    ];
  }
  return [];
}
