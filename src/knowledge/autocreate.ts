// Models create themselves. Nobody defines, names, seeds or approves a model.
//
//   1. Cluster active observations (embedding similarity) per scope.
//   2. A cluster that is substantial (>= MIN_CLUSTER_OBS observations backed by
//      >= MIN_CLUSTER_SESSIONS distinct sessions) and not already covered by an
//      existing model becomes a candidate.
//   3. Claude (tool-less) decides if it is worthy and names it + phrases the
//      standing question. Worthy => the model is created `active` immediately.
//   4. Core models (conventions & environment; per-project overview) are
//      guaranteed once enough observations exist, because those clusters always do.
//   5. Models whose evidence dried up are archived; near-identical models merge.

import * as path from 'node:path';
import { embed, getEmbedModelName } from '../utils/llm.js';
import { cosine } from '../engine/embedder.js';
import * as obsDb from '../store/db/observations.js';
import * as modelsDb from '../store/db/mental-models.js';
import { query } from '../store/db-client.js';
import type { Synthesizer } from './synth.js';
import { extractJsonObject } from './synth.js';
import { NAME_SYSTEM, buildNamePrompt } from './prompts.js';

export const CLUSTER_COSINE = 0.72;
export const MIN_CLUSTER_OBS = 4;
export const MIN_CLUSTER_SESSIONS = 3;
export const COVERED_COSINE = 0.7;
export const MERGE_COSINE = 0.88;
const MAX_NEW_MODELS_PER_RUN = 4;

export interface Cluster {
  members: obsDb.ObservationRecord[];
  centroid: number[];
}

function addInto(sum: number[], v: number[]): void { for (let i = 0; i < v.length; i++) sum[i] += v[i]; }

/** Greedy centroid clustering; deterministic given input order. */
export function clusterObservations(
  items: Array<{ rec: obsDb.ObservationRecord; vec: number[] }>, threshold = CLUSTER_COSINE,
): Cluster[] {
  const clusters: Array<{ members: obsDb.ObservationRecord[]; sum: number[]; n: number }> = [];
  const norm = (v: number[]) => { const l = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map(x => x / l); };
  for (const it of items) {
    let best = -1; let bestS = threshold;
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].sum.length !== it.vec.length) continue;
      const s = cosine(norm(clusters[i].sum), it.vec);
      if (s >= bestS) { bestS = s; best = i; }
    }
    if (best < 0) clusters.push({ members: [it.rec], sum: [...it.vec], n: 1 });
    else { clusters[best].members.push(it.rec); addInto(clusters[best].sum, it.vec); clusters[best].n++; }
  }
  return clusters.map(c => ({ members: c.members, centroid: norm(c.sum) }));
}

async function distinctSessions(obsIds: string[]): Promise<number> {
  if (obsIds.length === 0) return 0;
  const sessions = new Set<string>();
  for (let i = 0; i < obsIds.length; i += 400) {
    const slice = obsIds.slice(i, i + 400);
    const rows = await query<{ s: string }>(
      `SELECT DISTINCT COALESCE(f.session_id, f.source_memory_id, f.id) AS s
       FROM observation_evidence e JOIN facts f ON f.id = e.fact_id
       WHERE e.role = 'supports' AND e.observation_id IN (${slice.map(() => '?').join(',')})`, slice);
    for (const r of rows) sessions.add(r.s);
  }
  return sessions.size;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = modelsDb.slugify(base); let n = 2;
  while (taken.has(slug)) slug = `${modelsDb.slugify(base)}-${n++}`;
  taken.add(slug);
  return slug;
}

async function createFromCluster(
  scope: string, name: string, question: string, taken: Set<string>, origin: 'auto' | 'seed' = 'auto',
): Promise<string> {
  let qe: number[] | null = null;
  try { qe = await embed(`${name}. ${question}`); } catch { qe = null; }
  const slug = uniqueSlug(name, taken);
  await modelsDb.createModel({
    slug, name, sourceQuery: question, scope, origin,
    queryEmbedding: qe, embeddingModel: qe ? getEmbedModelName() : null,
  });
  return slug;
}

const scopeLabel = (scope: string) => scope === 'global' ? 'all projects' : path.basename(scope);

/** Guarantee the baseline models once enough observations exist. */
export async function ensureCoreModels(): Promise<string[]> {
  const created: string[] = [];
  const models = await modelsDb.listModels();
  const taken = new Set(models.map(m => m.slug));
  const activeObs = await obsDb.listActiveObservations(null, 5000);
  const byScope = new Map<string, number>();
  for (const o of activeObs) byScope.set(o.scope, (byScope.get(o.scope) ?? 0) + 1);

  const hasModel = (scope: string) => models.some(m => m.scope === scope && m.status !== 'archived');

  if ((byScope.get('global') ?? 0) >= 3 && !hasModel('global')) {
    created.push(await createFromCluster('global', 'Conventions and environment',
      "What standing conventions and ambient environment settings should be assumed across the user's work: default accounts/profiles/regions, hosts and paths, tools, naming, and how work should be verified?",
      taken, 'seed'));
  }
  for (const [scope, n] of byScope) {
    if (scope === 'global' || n < MIN_CLUSTER_OBS || hasModel(scope)) continue;
    created.push(await createFromCluster(scope, `${scopeLabel(scope)} overview`,
      `What is the current state of ${scopeLabel(scope)}: its architecture, the decisions made and why, and what was rejected?`,
      taken, 'seed'));
  }
  return created;
}

export interface AutoCreateStats {
  clustersConsidered: number;
  created: string[];
  coreCreated: string[];
  archived: string[];
  merged: string[];
  inputTokens: number;
  outputTokens: number;
}

export async function autoManageModels(synth: Synthesizer): Promise<AutoCreateStats> {
  const stats: AutoCreateStats = { clustersConsidered: 0, created: [], coreCreated: [], archived: [], merged: [], inputTokens: 0, outputTokens: 0 };

  stats.coreCreated = await ensureCoreModels();

  // Candidate clusters per scope.
  const models = await modelsDb.listModels({ status: 'active' });
  const taken = new Set((await modelsDb.listModels()).map(m => m.slug));
  const obs = await obsDb.listActiveObservations(null, 5000);
  const byScope = new Map<string, Array<{ rec: obsDb.ObservationRecord; vec: number[] }>>();
  for (const o of obs) {
    const vec = obsDb.observationEmbedding(o);
    if (!vec) continue;
    const arr = byScope.get(o.scope) ?? [];
    arr.push({ rec: o, vec });
    byScope.set(o.scope, arr);
  }

  for (const [scope, items] of byScope) {
    if (stats.created.length >= MAX_NEW_MODELS_PER_RUN) break;
    for (const cluster of clusterObservations(items)) {
      if (stats.created.length >= MAX_NEW_MODELS_PER_RUN) break;
      if (cluster.members.length < MIN_CLUSTER_OBS) continue;
      const sessions = await distinctSessions(cluster.members.map(m => m.id));
      if (sessions < MIN_CLUSTER_SESSIONS) continue;
      // Already covered by an existing model in this scope?
      const covered = models.some(m => {
        if (m.scope !== scope) return false;
        const qe = modelsDb.modelQueryEmbedding(m);
        return qe && qe.length === cluster.centroid.length && cosine(qe, cluster.centroid) >= COVERED_COSINE;
      });
      if (covered) continue;

      stats.clustersConsidered++;
      const res = await synth.complete({
        role: 'name', system: NAME_SYSTEM,
        prompt: buildNamePrompt(scope,
          models.filter(m => m.scope === scope || m.scope === 'global').map(m => ({ slug: m.slug, name: m.name, question: m.source_query })),
          cluster.members.slice(0, 14).map((m, i) => ({ id: `O${i + 1}`, text: m.text }))),
      });
      stats.inputTokens += res.inputTokens; stats.outputTokens += res.outputTokens;
      const j = extractJsonObject(res.text) as { worthy?: unknown; name?: unknown; question?: unknown } | null;
      if (!j || j.worthy !== true) continue;
      const name = typeof j.name === 'string' ? j.name.trim().slice(0, 80) : '';
      const question = typeof j.question === 'string' ? j.question.trim().slice(0, 300) : '';
      if (name.length < 3 || question.length < 10) continue;
      const slug = await createFromCluster(scope, name, question, taken);
      stats.created.push(slug);
      const fresh = await modelsDb.getModelBySlug(slug);
      if (fresh) models.push(fresh);
    }
  }

  stats.archived = await archiveDriedUpModels();
  stats.merged = await mergeOverlappingModels();
  return stats;
}

/** Auto models whose entire evidence base was superseded/retired are archived (kept as history). */
export async function archiveDriedUpModels(): Promise<string[]> {
  const out: string[] = [];
  for (const m of await modelsDb.listModels({ status: 'active' })) {
    if (m.origin === 'manual') continue;
    const based = modelsDb.modelBasedOn(m);
    if (!m.content || based.length === 0) continue;
    // based_on mixes observation and fact ids; getObservations returns only the observation rows.
    const live = await obsDb.getObservations(based);
    const anyActive = live.some(o => o.status === 'active');
    // facts-only evidence: keep (we can't cheaply tell); observation evidence all dead: archive
    if (live.length > 0 && !anyActive) { await modelsDb.setModelStatus(m.slug, 'archived'); out.push(m.slug); }
  }
  return out;
}

/** Near-identical models in the same scope merge: the one with less content is archived. */
export async function mergeOverlappingModels(): Promise<string[]> {
  const out: string[] = [];
  const models = (await modelsDb.listModels({ status: 'active' })).filter(m => m.origin !== 'manual');
  const gone = new Set<string>();
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i], b = models[j];
      if (gone.has(a.slug) || gone.has(b.slug) || a.scope !== b.scope) continue;
      const qa = modelsDb.modelQueryEmbedding(a), qb = modelsDb.modelQueryEmbedding(b);
      if (!qa || !qb || qa.length !== qb.length || cosine(qa, qb) < MERGE_COSINE) continue;
      const loser = (a.content?.length ?? 0) >= (b.content?.length ?? 0) ? b : a;
      await modelsDb.setModelStatus(loser.slug, 'archived');
      gone.add(loser.slug);
      out.push(loser.slug);
    }
  }
  return out;
}
