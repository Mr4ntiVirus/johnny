// `johnny synth run` — the always-on, zero-touch synthesis heartbeat.
//
// Orchestrated in CODE (a normal program, not a Claude session driving a CLI):
// it pulls work, calls Claude as a tool-less text->text function, validates and
// applies. Phases, in order, each bounded by the usage governor:
//
//   1. extract      pending memories -> windows -> facts   (+ verifier sample, auto-pause on bad rates)
//   2. consolidate  new facts per scope -> observations
//   3. models       auto-create / archive / merge, then refresh stale models (100% verified)
//   4. embed        backfill embeddings for facts that missed Ollama
//
// A cheap precheck (`synthStatus`) lets the scheduler skip the whole run, with
// zero model calls, when nothing is pending.

import { embed, getEmbedModelName } from '../utils/llm.js';
import * as jobs from '../store/db/jobs.js';
import * as factsDb from '../store/db/facts.js';
import * as chunksDb from '../store/db/chunks.js';
import * as modelsDb from '../store/db/mental-models.js';
import { query } from '../store/db-client.js';
import type { KnowledgeConfig } from '../types.js';
import { SynthError, type Synthesizer } from './synth.js';
import { extractWindows, type WindowContext } from './extract.js';
import { EXTRACTOR_VERSION } from './prompts.js';
import {
  buildWindowsForMemory, selectPendingMemories, countPendingMemories, markMemoryExtracted, scopeForProject,
} from './windows.js';
import { consolidateScope, scopesWithPendingFacts, type ConsolidateStats } from './consolidate.js';
import { autoManageModels, type AutoCreateStats } from './autocreate.js';
import { refreshStaleModels, modelIsStale, embedSections, type RefreshOutcome } from './refresh.js';
import { verifyFactSample } from './verify.js';
import { embedChunkText } from '../engine/chunker.js';
import { sweepDuplicateChunks } from '../maintenance/dedupe.js';
import { exportModelPages } from './export.js';
import { UsageGovernor, GovernedSynthesizer, BudgetStop, type StopReason } from './governor.js';
import { mapLimit } from './pool.js';

export const SYNTH_JOB = 'synth';
export const EXTRACT_JOB = 'extract';
export const MODELS_JOB = 'models';

export interface SynthStatus {
  pendingMemories: number;
  pendingConsolidateScopes: number;
  staleModels: number;
  pendingKicks: boolean;
  pendingEmbeddings: number;
  paused: string[];
  backoffUntil: string | null;
  needsWork: boolean;
}

export async function synthStatus(): Promise<SynthStatus> {
  try { await modelsDb.resumeCooledModels(); } catch { /* best-effort */ }
  const [pendingMemories, scopes, models, kicks, allJobs, usage, embRows] = await Promise.all([
    countPendingMemories(EXTRACTOR_VERSION),
    scopesWithPendingFacts(),
    modelsDb.listModels({ status: 'active' }),
    jobs.anyPending(),
    jobs.listJobs(),
    jobs.getJob('synth-usage', ''),
    query<{ n: number }>(`SELECT (SELECT COUNT(*) FROM chunks WHERE embedding IS NULL) + (SELECT COUNT(*) FROM facts WHERE embedding IS NULL) + (SELECT COUNT(*) FROM mental_models WHERE status = 'active' AND content IS NOT NULL AND section_embeddings IS NULL) AS n`),
  ]);
  const pendingEmbeddings = Number(embRows[0]?.n) || 0;
  let staleModels = 0;
  for (const m of models) if (await modelIsStale(m)) staleModels++;
  const paused = allJobs.filter(j => j.paused && ['extract', 'consolidate', 'models', 'synth'].includes(j.job)).map(j => `${j.job}${j.scope ? `:${j.scope}` : ''}`);
  const until = usage?.watermark && Date.parse(usage.watermark) > Date.now() ? usage.watermark : null;
  const extractPaused = paused.includes('extract') || paused.includes('synth');
  const needsWork = !until && !paused.includes('synth') && (
    (pendingMemories > 0 && !extractPaused) || scopes.length > 0 || staleModels > 0 || kicks || pendingEmbeddings > 0);
  return { pendingMemories, pendingConsolidateScopes: scopes.length, staleModels, pendingKicks: kicks, pendingEmbeddings, paused, backoffUntil: until, needsWork };
}

export interface RunReport {
  startedAt: string;
  durationMs: number;
  skipped?: string;
  stopped: StopReason | 'done' | 'paused' | 'error';
  extraction: {
    memories: number; windows: number; windowsFailed: number; factsAccepted: number; factsRejected: number;
    rejectReasons: Record<string, number>; verifierChecked: number; verifierUnsupported: number;
  };
  consolidation: { scopes: number; created: number; updated: number; superseded: number; retired: number; merged: number; rejected: number };
  models: { created: string[]; coreCreated: string[]; archived: string[]; merged: string[]; refreshed: string[]; unchanged: number; failed: Array<{ slug: string; reason: string }> };
  embedded: number;
  swept: number;
  pagesExported: number;
  usage: { runCalls: number; runTokens: number; callsToday: number; tokensToday: number };
  backlog: { memories: number; staleModels: number };
  errors: string[];
  notes: string[];
}

const emptyReport = (): RunReport => ({
  startedAt: new Date().toISOString(), durationMs: 0, stopped: 'done',
  extraction: { memories: 0, windows: 0, windowsFailed: 0, factsAccepted: 0, factsRejected: 0, rejectReasons: {}, verifierChecked: 0, verifierUnsupported: 0 },
  consolidation: { scopes: 0, created: 0, updated: 0, superseded: 0, retired: 0, merged: 0, rejected: 0 },
  models: { created: [], coreCreated: [], archived: [], merged: [], refreshed: [], unchanged: 0, failed: [] },
  embedded: 0, swept: 0, pagesExported: 0, usage: { runCalls: 0, runTokens: 0, callsToday: 0, tokensToday: 0 },
  backlog: { memories: 0, staleModels: 0 }, errors: [], notes: [],
});

/** True when work was attempted, nothing was produced, and failures were recorded. */
export function totalFailureNoSuccess(r: RunReport, runCalls = 1): boolean {
  if (runCalls <= 0) return false; // nothing was sent to the model, so nothing "failed"
  const failures = r.extraction.windowsFailed + r.models.failed.length + r.errors.length;
  const c = r.consolidation;
  const successes = r.extraction.factsAccepted + c.created + c.updated + c.superseded + c.retired + c.merged
    + r.models.created.length + r.models.coreCreated.length + r.models.refreshed.length + r.models.unchanged;
  return failures > 0 && successes === 0;
}

const sessionOf = (sourceUri: string | null, fallback: string): string => {
  const m = sourceUri?.match(/session\/([^/]+?)\.jsonl/);
  return m ? m[1] : fallback;
};

export interface RunOptions {
  synth: Synthesizer;
  config: KnowledgeConfig;
  log?: (msg: string) => void;
  /** Restrict phases (default all). */
  phases?: Array<'maintain' | 'extract' | 'consolidate' | 'models' | 'embed'>;
  /** Cap memories processed in the extract phase (default unlimited within budget). */
  maxMemories?: number;
  /** Injected RNG for verifier sampling (tests). */
  rng?: () => number;
}

export async function runSynthesis(opts: RunOptions): Promise<RunReport> {
  const t0 = Date.now();
  const report = emptyReport();
  const say = opts.log ?? (() => {});
  const phases = new Set(opts.phases ?? ['maintain', 'extract', 'consolidate', 'models', 'embed']);
  const owner = `synth-${process.pid}-${t0}`;

  if (!(await jobs.claimJob(SYNTH_JOB, '', owner, 3 * 60 * 60_000))) {
    report.skipped = 'another synthesis run is active (or the job is paused)';
    report.stopped = 'paused';
    return report;
  }

  const gov = await UsageGovernor.load(opts.config.synth);
  const synth = new GovernedSynthesizer(opts.synth, gov);
  const cfg = opts.config.synth;

  try {
    // ── 0. housekeeping: standing duplicate sweep (chunk rows only) ──
    if (phases.has('maintain')) {
      try {
        const sw = await sweepDuplicateChunks();
        report.swept = sw.deleted;
        if (sw.deleted > 0) report.notes.push(`dedupe sweep removed ${sw.deleted} straggler duplicate chunks`);
      } catch (err) { report.errors.push(`sweep: ${err}`); }
    }
    // ── 1. extraction ──
    if (phases.has('extract')) await runExtraction(synth, cfg, report, say, opts);
    // ── 2. consolidation ──
    if (phases.has('consolidate')) await runConsolidation(synth, report, say, Math.max(1, cfg.concurrency ?? 1));
    // ── 3. models ──
    if (phases.has('models')) {
      await runModels(synth, report, say, Math.max(1, cfg.concurrency ?? 1));
      // (skipped under the test mock flag so suites never write into the real ~/.johnny)
      if (!process.env.JOHNNY_LLM_MOCK) {
        try { report.pagesExported = (await exportModelPages()).written; } catch (err) { report.errors.push(`export: ${err}`); }
      }
    }
    // ── 4. embeddings ──
    if (phases.has('embed')) report.embedded = await backfillEmbeddings();
    if ((report.stopped as RunReport['stopped']) === 'done' && totalFailureNoSuccess(report, gov.snapshot().runCalls)) {
      // Every model call failed (e.g. a launchd session that is not logged in). Calling that
      // "done" hid a whole run of nothing; record it as an error so the doctor and the email say so.
      report.stopped = 'error';
      const why = report.models.failed[0]?.reason ?? report.errors[0] ?? 'model calls failed';
      report.errors.push(`no model call succeeded (${report.extraction.windowsFailed} windows, ${report.models.failed.length} models failed): ${why}`);
      // Deliberately NOT jobs.recordFailure: that pauses the job after repeated failures, and a paused
      // heartbeat needs a human. An all-failed run (e.g. launchd not logged in) must stay retryable.
    }
  } catch (err) {
    if (err instanceof BudgetStop) {
      report.stopped = err.reason;
      report.notes.push(`stopped: ${err.message}`);
    } else {
      report.stopped = 'error';
      report.errors.push(String(err));
      await jobs.recordFailure(SYNTH_JOB, '', String(err));
    }
  } finally {
    report.durationMs = Date.now() - t0;
    report.usage = gov.snapshot();
    try { await gov.persist(); } catch { /* best-effort */ }
    try {
      const st = await synthStatus();
      report.backlog = { memories: st.pendingMemories, staleModels: st.staleModels };
      await jobs.recordStats(SYNTH_JOB, '', { ...report, finishedAt: new Date().toISOString() } as unknown as Record<string, unknown>);
      if (report.stopped === 'done') await jobs.recordSuccess(SYNTH_JOB, '');
      await jobs.setPending(EXTRACT_JOB, '', st.pendingMemories > 0);
      await jobs.setPending(MODELS_JOB, '', st.staleModels > 0);
    } catch { /* best-effort */ }
    await jobs.releaseJob(SYNTH_JOB, '', owner);
  }
  return report;
}

async function runExtraction(
  synth: Synthesizer, cfg: KnowledgeConfig['synth'], report: RunReport,
  say: (m: string) => void, opts: RunOptions,
): Promise<void> {
  const ex = await jobs.getJob(EXTRACT_JOB, '');
  if (ex?.paused) { report.notes.push(`extraction paused (${ex.last_error ?? 'previous failures'}); resume with: johnny synth resume extract`); return; }

  let accepted = 0, rejected = 0, checked = 0, unsupported = 0, sent = 0, failed = 0;
  const limit = opts.maxMemories ?? cfg.maxMemoriesPerRun ?? Number.POSITIVE_INFINITY;
  // Memories that could not complete this run (a window failed or was dropped) are
  // deferred to the next run instead of being re-selected forever; their failed
  // windows are abandoned after MAX_WINDOW_ATTEMPTS attempts, so nothing stalls.
  const deferred = new Set<string>();

  while (report.extraction.memories < limit) {
    const batch = await selectPendingMemories(EXTRACTOR_VERSION, Math.min(cfg.memoriesPerBatch, limit - report.extraction.memories), [...deferred]);
    if (batch.length === 0) break;

    // Build windows for the batch.
    const ctxs: WindowContext[] = [];
    const byMemory = new Map<string, WindowContext[]>();
    for (const m of batch) {
      const windows = await buildWindowsForMemory(m.id);
      if (windows.length === 0) { await markMemoryExtracted(m.id, EXTRACTOR_VERSION, 0); report.extraction.memories++; continue; }
      const list: WindowContext[] = windows.map(w => ({
        ...w, scope: scopeForProject(m.project_path), sessionId: sessionOf(m.source_uri, m.id),
        mentionedAt: m.created_at, title: m.title,
      }));
      byMemory.set(m.id, list);
      ctxs.push(...list);
    }

    // Send windows in groups per call, `concurrency` calls at a time (windows are independent;
    // every call still passes through the governor). Failures are handled after the wave settles.
    const created: Awaited<ReturnType<typeof extractWindows>>['created'] = [];
    const groups: WindowContext[][] = [];
    for (let i = 0; i < ctxs.length; i += cfg.windowsPerCall) groups.push(ctxs.slice(i, i + cfg.windowsPerCall));
    const conc = Math.max(1, cfg.concurrency ?? 1);
    for (let g = 0; g < groups.length; g += conc) {
      const wave = await Promise.allSettled(groups.slice(g, g + conc).map(group => extractWindows(synth, group)));
      let budgetStop: BudgetStop | null = null;
      let transient = false;
      for (const r of wave) {
        if (r.status === 'fulfilled') {
          const st = r.value;
          report.extraction.windows += st.windowsSent;
          report.extraction.factsAccepted += st.factsAccepted;
          report.extraction.factsRejected += st.factsRejected;
          accepted += st.factsAccepted; rejected += st.factsRejected;
          sent += st.windowsSent; failed += st.windowsFailed;
          report.extraction.windowsFailed += st.windowsFailed;
          for (const [k, v] of Object.entries(st.rejectReasons)) report.extraction.rejectReasons[k] = (report.extraction.rejectReasons[k] ?? 0) + v;
          created.push(...st.created);
          continue;
        }
        const err = r.reason;
        if (err instanceof BudgetStop) { budgetStop = budgetStop ?? err; continue; }
        report.errors.push(`extract: ${err}`);
        if (err instanceof SynthError) { transient = true; continue; }
        const paused = await jobs.recordFailure(EXTRACT_JOB, '', String(err));
        if (paused) { report.notes.push('extraction auto-paused after repeated failures'); return; }
      }
      if (budgetStop) throw budgetStop;
      if (transient) {
        // Infrastructure (CLI crash/timeout): transient. Stop this run and let the next
        // heartbeat retry — never count it toward the content-failure auto-pause.
        report.notes.push('model call failed (infrastructure); stopping this run, will retry next heartbeat');
        return;
      }
    }

    // A memory is done only when every one of its windows is logged done/skipped.
    for (const [memoryId, list] of byMemory) {
      let done = true; let facts = 0;
      for (const w of list) {
        const log = await factsDb.getExtractionLog(w.hash, EXTRACTOR_VERSION);
        if (!log || log.status === 'failed') { done = false; break; }
        facts += log.fact_count;
      }
      if (done) { await markMemoryExtracted(memoryId, EXTRACTOR_VERSION, facts); report.extraction.memories++; }
      else deferred.add(memoryId);
    }
    if (report.extraction.windowsFailed > 0 && report.extraction.memories === 0 && deferred.size >= 3 * cfg.memoriesPerBatch) {
      report.notes.push('extraction is failing on most windows; stopping this run'); break;
    }

    // Verifier sample on the new facts.
    let v = { checked: 0, unsupported: 0 };
    try { v = await verifyFactSample(synth, created, cfg.verifySampleRate, opts.rng); }
    catch (err) {
      if (err instanceof BudgetStop) throw err;
      report.notes.push(`verifier call failed (skipped this batch): ${String(err).slice(0, 120)}`);
    }
    checked += v.checked; unsupported += v.unsupported;
    report.extraction.verifierChecked = checked; report.extraction.verifierUnsupported = unsupported;

    // Automated quality gates -> auto-pause (the after-action report says why).
    const total = accepted + rejected;
    if (total >= 40 && rejected / total > cfg.pauseRejectRate) {
      await jobs.pauseJob(EXTRACT_JOB, '', `reject rate ${(100 * rejected / total).toFixed(0)}% over ${total} facts`);
      report.notes.push(`extraction auto-paused: ${(100 * rejected / total).toFixed(0)}% of extracted facts failed validation`);
      return;
    }
    if (checked >= 12 && unsupported / checked > cfg.pauseRejectRate) {
      await jobs.pauseJob(EXTRACT_JOB, '', `verifier rejected ${unsupported}/${checked} sampled facts`);
      report.notes.push(`extraction auto-paused: verifier found ${unsupported}/${checked} sampled facts unsupported`);
      return;
    }
    if (sent >= 12 && failed / sent > cfg.pauseRejectRate) {
      await jobs.pauseJob(EXTRACT_JOB, '', `${failed}/${sent} windows produced unusable model output`);
      report.notes.push(`extraction auto-paused: the model's output was unusable for ${failed}/${sent} windows`);
      return;
    }
    say(`extract: ${report.extraction.memories} memories · ${accepted} facts so far`);
  }
  if (deferred.size > 0) report.notes.push(`${deferred.size} memories deferred to the next run (some windows failed; abandoned after ${3} attempts each)`);
}

async function runConsolidation(
  synth: Synthesizer, report: RunReport, say: (m: string) => void, concurrency: number,
): Promise<void> {
  const scopes = await scopesWithPendingFacts();
  // Scopes are independent (disjoint observations, per-scope claims), so run a few at once.
  const settled = await mapLimit(scopes, concurrency, async (scope) => {
    for (let pass = 0; pass < 40; pass++) {
      let st: ConsolidateStats | null;
      try { st = await consolidateScope(synth, scope); }
      catch (err) {
        if (err instanceof BudgetStop) throw err;
        report.errors.push(`consolidate ${scope}: ${err}`);
        break;
      }
      if (!st) break;
      report.consolidation.created += st.created;
      report.consolidation.updated += st.updated;
      report.consolidation.superseded += st.superseded;
      report.consolidation.retired += st.retired;
      report.consolidation.merged += st.mergedAsDuplicate;
      report.consolidation.rejected += st.rejected;
    }
    report.consolidation.scopes++;
    say(`consolidate: ${scope}`);
  });
  const stop = settled.find(r => r.status === 'rejected' && r.reason instanceof BudgetStop) as PromiseRejectedResult | undefined;
  if (stop) throw stop.reason;
}

async function runModels(synth: Synthesizer, report: RunReport, say: (m: string) => void, concurrency: number): Promise<void> {
  const mj = await jobs.getJob(MODELS_JOB, '');
  if (mj?.paused) { report.notes.push('model refresh paused'); return; }
  let auto: AutoCreateStats;
  try { auto = await autoManageModels(synth); }
  catch (err) { if (err instanceof BudgetStop) throw err; report.errors.push(`models: ${err}`); return; }
  report.models.created = auto.created;
  report.models.coreCreated = auto.coreCreated;
  report.models.archived = auto.archived;
  report.models.merged = auto.merged;

  const results = await refreshStaleModels(synth, { concurrency });
  for (const { slug, outcome } of results) {
    const o: RefreshOutcome = outcome;
    if (o.status === 'written') report.models.refreshed.push(slug);
    else if (o.status === 'failed') report.models.failed.push({ slug, reason: o.reason });
    else report.models.unchanged++;
  }
  say(`models: ${report.models.refreshed.length} refreshed`);
}

const EMBED_BACKFILL_CHUNKS_PER_RUN = 400;

/**
 * Local embedding backfill (runs where the transcripts live). The daemon's
 * embed-backfill only sees Postgres, so chunks written by hooks to the local
 * store with embedding=null (Ollama busy/offline at write time, or the hook's
 * deadline hit) are filled in here, plus facts that missed their embedding.
 */
export async function backfillEmbeddings(): Promise<number> {
  let n = 0;
  const model = getEmbedModelName();
  // One poison item (e.g. text Ollama rejects) must not block the rest: skip it and
  // only give up after several consecutive failures (Ollama genuinely down/busy).
  let consecutiveFailures = 0;
  for (const c of await chunksDb.getChunksNeedingEmbedding(EMBED_BACKFILL_CHUNKS_PER_RUN)) {
    try {
      await chunksDb.setChunkEmbedding(c.chunk_id, await embedChunkText(c.text), model);
      n++; consecutiveFailures = 0;
    } catch { if (++consecutiveFailures >= 5) break; }
  }
  // Models written before section embeddings existed (or while the embedder was down).
  for (const m of await modelsDb.modelsNeedingSectionEmbeddings()) {
    const vecs = m.content ? await embedSections(m.content) : null;
    if (vecs) { await modelsDb.setModelSectionEmbeddings(m.slug, vecs); n++; }
  }
  consecutiveFailures = 0;
  for (const f of await factsDb.getFactsNeedingEmbedding(200)) {
    try { await factsDb.setFactEmbedding(f.id, await embed(f.text), model); n++; consecutiveFailures = 0; }
    catch { if (++consecutiveFailures >= 5) break; }
  }
  return n;
}

export function formatReport(r: RunReport): string {
  const mins = Math.max(1, Math.round(r.durationMs / 60000));
  const reasons = Object.entries(r.extraction.rejectReasons).map(([k, v]) => `${k} ${v}`).join(', ');
  const lines = [
    `Johnny memory synthesis — ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC (${mins} min) — ${r.skipped ? `skipped: ${r.skipped}` : `finished: ${r.stopped}`}`,
    '',
    `Extraction: ${r.extraction.memories} memories → ${r.extraction.windows} windows${r.extraction.windowsFailed ? ` (${r.extraction.windowsFailed} unusable)` : ''} → ${r.extraction.factsAccepted} facts accepted, ${r.extraction.factsRejected} rejected${reasons ? ` (${reasons})` : ''}.`,
    `  Verifier: checked ${r.extraction.verifierChecked} sampled facts, ${r.extraction.verifierUnsupported} unsupported.`,
    `Consolidation: ${r.consolidation.scopes} scopes → ${r.consolidation.created} observations created, ${r.consolidation.updated} updated, ${r.consolidation.superseded} superseded, ${r.consolidation.retired} retired, ${r.consolidation.merged} merged as duplicates, ${r.consolidation.rejected} proposals rejected by validators.`,
    `Models: ${r.models.created.length + r.models.coreCreated.length} created${[...r.models.coreCreated, ...r.models.created].length ? ` (${[...r.models.coreCreated, ...r.models.created].join(', ')})` : ''}, ${r.models.refreshed.length} refreshed${r.models.refreshed.length ? ` (${r.models.refreshed.join(', ')})` : ''}, ${r.models.archived.length} archived, ${r.models.merged.length} merged, ${r.models.unchanged} already current${r.models.failed.length ? `, ${r.models.failed.length} failed (${r.models.failed.map(f => `${f.slug}: ${f.reason.slice(0, 80)}`).join('; ')})` : ''}.`,
    `Knowledge pages: ${r.pagesExported} written to ~/.johnny/knowledge.`,
    `Usage: ${r.usage.runCalls} calls · ~${Math.round(r.usage.runTokens / 1000)}k tokens this run · ${r.usage.callsToday} calls today.`,
    `Backlog: ${r.backlog.memories} memories still to extract · ${r.backlog.staleModels} stale models.`,
  ];
  if (r.notes.length) lines.push('', ...r.notes.map(n => `Note: ${n}`));
  if (r.errors.length) lines.push('', ...r.errors.map(e => `Error: ${e.slice(0, 300)}`));
  return lines.join('\n');
}

// `query` is re-exported for the CLI's quick counts without another import.
export { query };
