// Knowledge-layer slice of the doctor snapshot: layer sizes, priming activity and
// failures, and synthesis-heartbeat health. Read-only; any failure yields null so
// the doctor never breaks because of this panel.
import { queryOne } from './db-client.js';
import { getJob } from './db/jobs.js';
import { getPrimeStats, getLastPrimeEvent, type PrimeWindowStats } from './db/prime-events.js';
import { synthStatus } from '../knowledge/run.js';
import { isArmed, INTERVAL_SECONDS } from '../knowledge/heartbeat.js';

export interface KnowledgeStats {
  facts: number;
  observations: number;
  models: number;
  disputedFacts: number;
  prime: { hour: PrimeWindowStats; day: PrimeWindowStats; week: PrimeWindowStats; lastEventAt: string | null; lastFailureAt: string | null; lastError: string | null };
  synth: {
    armed: boolean; lastRunAt: string | null; lastRunStopped: string | null; lastRunFailures: number; lastRunProductive: boolean; lastRunError: string | null; overdue: boolean;
    pendingMemories: number; staleModels: number; paused: string[]; backoffUntil: string | null;
  };
  verifier: { checked: number; unsupported: number } | null;
}

const STATUS_TTL_MS = 60_000; // synthStatus walks every model; doctor refreshes far more often
let cached: { at: number; value: Awaited<ReturnType<typeof synthStatus>> & { armed: boolean } } | null = null;

async function cachedSynthStatus() {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const value = { ...(await synthStatus()), armed: isArmed() };
  cached = { at: Date.now(), value };
  return value;
}

const count = async (sql: string): Promise<number> => Number((await queryOne<{ n: number }>(sql))?.n) || 0;

export async function collectKnowledgeStats(): Promise<KnowledgeStats | null> {
  try {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const [facts, observations, models, disputedFacts, hour, day, week, last, lastFail, st, job] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM facts WHERE status = 'active'`),
      count(`SELECT COUNT(*) AS n FROM observations WHERE status = 'active'`),
      count(`SELECT COUNT(*) AS n FROM mental_models WHERE status = 'active'`),
      count(`SELECT COUNT(*) AS n FROM facts WHERE status = 'disputed'`),
      getPrimeStats(iso(3_600_000)), getPrimeStats(iso(86_400_000)), getPrimeStats(iso(7 * 86_400_000)),
      getLastPrimeEvent(),
      queryOne<{ created_at: string; error: string | null }>(
        `SELECT created_at, error FROM prime_events WHERE outcome = 'failed' ORDER BY created_at DESC LIMIT 1`),
      cachedSynthStatus(),
      getJob('synth', ''),
    ]);
    let report: { finishedAt?: string; stopped?: string; errors?: string[]; models?: { failed?: Array<{ reason?: string }>; refreshed?: unknown[]; created?: unknown[]; unchanged?: number }; extraction?: { verifierChecked?: number; verifierUnsupported?: number; factsAccepted?: number }; consolidation?: { created?: number; updated?: number; superseded?: number } } = {};
    try { report = job?.stats ? JSON.parse(job.stats) : {}; } catch { /* unparseable stats: treat as no run */ }
    const lastRunAt = report.finishedAt ?? null;
    // Heartbeat fires every INTERVAL_SECONDS; 2x with nothing recorded = stalled.
    const overdue = st.armed && (!lastRunAt || now - Date.parse(lastRunAt) > INTERVAL_SECONDS * 2 * 1000) && st.needsWork;
    // The run's `stopped` label says 'done' even when every model call failed (e.g. auth), so
    // judge success by the errors it recorded.
    const failures = (report.errors?.length ?? 0) + (report.models?.failed?.length ?? 0);
    const lastRunError = (report.errors?.[0] ?? report.models?.failed?.[0]?.reason ?? null)?.replace(/^\w[\w:/ .-]*?: (?=SynthError)/, '') ?? null;
    // A run that failed on a model or two but still produced work is a retry, not an outage.
    const productive = (report.extraction?.factsAccepted ?? 0) + (report.consolidation?.created ?? 0) + (report.consolidation?.updated ?? 0)
      + (report.consolidation?.superseded ?? 0) + (report.models?.refreshed?.length ?? 0) + (report.models?.created?.length ?? 0) + (report.models?.unchanged ?? 0) > 0;
    const checked = report.extraction?.verifierChecked ?? 0;
    return {
      facts, observations, models, disputedFacts,
      prime: { hour, day, week, lastEventAt: last?.created_at ?? null, lastFailureAt: lastFail?.created_at ?? null, lastError: lastFail?.error ?? null },
      synth: {
        armed: st.armed, lastRunAt, lastRunStopped: report.stopped ?? null, lastRunFailures: failures, lastRunProductive: productive && report.stopped !== 'error', lastRunError, overdue,
        pendingMemories: st.pendingMemories, staleModels: st.staleModels, paused: st.paused, backoffUntil: st.backoffUntil,
      },
      verifier: checked > 0 ? { checked, unsupported: report.extraction?.verifierUnsupported ?? 0 } : null,
    };
  } catch {
    return null;
  }
}
