// MCP introspection tools for the knowledge layer. These are the opt-in,
// Claude-driven side of memory: automatic priming (hook) does the work without
// being asked; these let Claude look deeper or correct memory at will.
//
// Nothing here calls an LLM — Claude is the reasoner. `johnny_reflect` is
// Hindsight's reflect loop with deterministic retrieval: compiled models first,
// then the observations behind them, then facts with their evidence quotes,
// then raw memory tiles.

import { embed } from '../utils/llm.js';
import * as modelsDb from '../store/db/mental-models.js';
import * as obsDb from '../store/db/observations.js';
import * as factsDb from '../store/db/facts.js';
import * as jobs from '../store/db/jobs.js';
import { searchKnowledge, evidenceFor, type KnowledgeHit } from '../knowledge/retrieve.js';
import { modelIsStale } from '../knowledge/refresh.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  [k: string]: unknown;
}
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const day = (iso: string | null | undefined) => (iso ?? '').slice(0, 10) || 'unknown';
const trim = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');

/** Tile body for a knowledge hit inside johnny_recall (prose, with provenance). */
export function knowledgeTileText(h: KnowledgeHit): string {
  if (h.kind === 'model') {
    const stale = h.stale ? ' · MAY BE OUT OF DATE (newer notes exist; verify with johnny_reflect)' : '';
    return `[compiled model "${h.title}" · refreshed ${day(h.asOf)}${stale}]\n${h.text}`;
  }
  if (h.kind === 'observation') {
    return `[observation · ${h.proof} session${h.proof === 1 ? '' : 's'} · updated ${day(h.asOf)}]\n${h.text}`;
  }
  return `[${h.title} fact · ${day(h.asOf)}]\n${h.text}`;
}

export function knowledgeTilesForRecall(hits: KnowledgeHit[]): KnowledgeHit[] {
  // Layer order, bounded: 1 model, <=3 observations, <=3 facts.
  const take = (kind: KnowledgeHit['kind'], n: number) => hits.filter(h => h.kind === kind).slice(0, n);
  return [...take('model', 1), ...take('observation', 3), ...take('fact', 3)];
}

// ── johnny_models ────────────────────────────────────────────────────────────

export interface ModelsArgs { name?: string; refresh?: boolean }

export async function handleModels(args: ModelsArgs): Promise<ToolResult> {
  try {
    if (!args.name) {
      const models = await modelsDb.listModels({ status: 'active' });
      if (models.length === 0) {
        return text('No compiled mental models yet. Johnny builds them automatically in the background once enough observations have accumulated.');
      }
      const lines: string[] = [`${models.length} compiled mental model${models.length === 1 ? '' : 's'} (built and refreshed automatically):`, ''];
      for (const m of models) {
        const stale = await modelIsStale(m);
        lines.push(`${m.slug}  ·  ${m.name}`);
        lines.push(`  Scope: ${m.scope}   Refreshed: ${day(m.last_refreshed_at)}${stale ? '   (stale — refresh pending)' : ''}${m.paused ? '   (paused after repeated failures)' : ''}`);
        lines.push(`  Answers: ${m.source_query}`);
        lines.push('');
      }
      lines.push('Read one in full with johnny_models({name: "<slug>"}).');
      return text(lines.join('\n'));
    }

    const m = await modelsDb.getModelBySlug(args.name);
    if (!m) return text(`No model named "${args.name}". Call johnny_models with no arguments to list them.`);
    if (args.refresh) {
      await modelsDb.forceStale([m.slug]);
      await jobs.setPending('models', '', true);
    }
    const stale = await modelIsStale(m);
    const evidence = modelsDb.modelBasedOn(m).length;
    const header = [
      `${m.name}  (${m.slug})`,
      `Scope: ${m.scope}  ·  refreshed ${day(m.last_refreshed_at)}  ·  built from ${evidence} observation/fact${evidence === 1 ? '' : 's'}${stale ? '  ·  STALE (refresh queued for the next background run)' : ''}`,
      `Answers: ${m.source_query}`,
      args.refresh ? 'Refresh requested: it will be rebuilt by the next background synthesis run.' : '',
      '',
    ].filter((l, i) => l !== '' || i > 2);
    return text([...header, m.content ?? '(not compiled yet — waiting for the next background run)'].join('\n'));
  } catch (err) {
    return text(`Error: ${err}`);
  }
}

// ── johnny_reflect ───────────────────────────────────────────────────────────

export interface ReflectArgs { question: string; depth?: 'summary' | 'evidence' }

export interface ReflectDeps {
  /** Raw-memory fallback: top excerpts for the question (injected to avoid a circular import). */
  rawTiles: (question: string) => Promise<Array<{ memoryName: string; chunkId: string; text: string; score: number }>>;
}

export async function handleReflect(args: ReflectArgs, deps: ReflectDeps): Promise<ToolResult> {
  const question = (args.question ?? '').trim();
  if (!question) return text('Reflect requires a question, e.g. johnny_reflect({question: "how is the build pipeline set up?"}).');
  try {
    let qv: number[] | null = null;
    try { qv = await embed(question); } catch { qv = null; }
    const hits = qv ? await searchKnowledge(qv, { scope: null, limit: 14, minSimilarity: 0.4, withStaleness: true }) : [];
    const models = hits.filter(h => h.kind === 'model').slice(0, 2);
    const observations = hits.filter(h => h.kind === 'observation').slice(0, 4);
    const facts = hits.filter(h => h.kind === 'fact').slice(0, 5);
    const raw = (await deps.rawTiles(question)).slice(0, 3);
    const withEvidence = args.depth !== 'summary';

    const out: string[] = [
      `Reflection on "${question}" — compiled knowledge first, then the evidence beneath it.`,
      'Compiled layers are verified summaries; if a layer is marked stale, check the evidence below it.',
      '',
    ];

    if (models.length > 0) {
      out.push('COMPILED MODELS');
      for (const m of models) {
        out.push(`• ${m.title}  [${m.ref}]  refreshed ${day(m.asOf)}${m.stale ? '  (STALE)' : ''}  ·  ${Math.round(m.similarity * 100)}% match`);
        out.push(trim(m.text, 1400).split('\n').map(l => `    ${l}`).join('\n'));
        out.push('');
      }
    }
    if (observations.length > 0) {
      out.push('OBSERVATIONS (consolidated beliefs)');
      for (const o of observations) {
        out.push(`• ${o.text}  [${o.ref}]`);
        out.push(`    backed by ${o.proof} session${o.proof === 1 ? '' : 's'} · updated ${day(o.asOf)}${o.disputed ? ' · DISPUTED' : ''} · ${Math.round(o.similarity * 100)}% match`);
        if (withEvidence) {
          for (const e of (await evidenceFor(o.ref)).slice(0, 2)) {
            out.push(`    evidence: ${trim(e.text, 160)}${e.quote ? `  — "${trim(e.quote, 100)}"` : ''}`);
          }
        }
      }
      out.push('');
    }
    if (facts.length > 0) {
      out.push('FACTS (extracted statements)');
      for (const f of facts) out.push(`• ${f.text}  [${f.ref}] · ${f.title} · ${day(f.asOf)}`);
      out.push('');
    }
    if (raw.length > 0) {
      out.push('RAW MEMORY (original conversation excerpts)');
      for (const t of raw) {
        out.push(`• ${t.memoryName}  ·  ${Math.round(t.score * 100)}%  ·  ${t.chunkId}`);
        out.push(trim(t.text.replace(/\s+/g, ' '), 320).split('\n').map(l => `    ${l}`).join('\n'));
      }
      out.push('');
    }
    if (models.length + observations.length + facts.length + raw.length === 0) {
      return text(`Nothing in memory matched "${question}". Try johnny_search to browse, or rephrase.`);
    }
    out.push('If something here is wrong or outdated, flag it with johnny_invalidate({name: "<ref>", reason: "..."}) so it is corrected on the next background run.');
    return text(out.join('\n'));
  } catch (err) {
    return text(`Error: ${err}`);
  }
}

// ── johnny_invalidate for knowledge refs ─────────────────────────────────────

export const isKnowledgeRef = (name: string): boolean => /^(fact|obs|model):/.test(name);

export async function invalidateKnowledgeRef(ref: string, reason?: string): Promise<ToolResult> {
  try {
    const [kind, ...rest] = ref.split(':');
    const id = rest.join(':');
    const why = reason ? ` Reason: ${reason}` : '';
    if (kind === 'fact') {
      const f = await factsDb.getFact(id);
      if (!f) return text(`No fact "${id}".`);
      const status = await factsDb.invalidateFact(id);
      // Anything built on this fact must be revisited.
      const obsIds = await obsDb.observationsForFact(id);
      for (const oid of obsIds) {
        await obsDb.addEvidence(oid, id, null, 'contradicts');
        await obsDb.recomputeProof(oid);
      }
      await requeueFor(obsIds, f.scope);
      return text(`Fact flagged (now ${status}). ${obsIds.length} observation${obsIds.length === 1 ? '' : 's'} built on it will be reconsidered on the next background run.${why}`);
    }
    if (kind === 'obs') {
      const o = await obsDb.getObservation(id);
      if (!o) return text(`No observation "${id}".`);
      await obsDb.invalidateObservation(id);
      await requeueFor([id], o.scope);
      return text(`Observation flagged. It stops being auto-recalled once flagged twice, and dependent models refresh on the next background run.${why}`);
    }
    if (kind === 'model') {
      const m = await modelsDb.getModelBySlug(id);
      if (!m) return text(`No model "${id}".`);
      await modelsDb.forceStale([id]);
      await jobs.setPending('models', '', true);
      return text(`Model "${id}" marked stale; it will be rebuilt from current evidence on the next background run.${why}`);
    }
    return text(`Unrecognised reference "${ref}". Use fact:<id>, obs:<id> or model:<slug>.`);
  } catch (err) {
    return text(`Error: ${err}`);
  }
}

async function requeueFor(obsIds: string[], scope: string): Promise<void> {
  const models = await modelsDb.listModels({ status: 'active' });
  const stale = models.filter(m => modelsDb.modelBasedOn(m).some(id => obsIds.includes(id))).map(m => m.slug);
  if (stale.length > 0) await modelsDb.forceStale(stale);
  await jobs.setPending('consolidate', scope, true);
  await jobs.setPending('models', '', true);
}
