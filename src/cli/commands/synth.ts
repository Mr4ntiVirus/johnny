// johnny synth — the knowledge-synthesis heartbeat.
//
//   johnny synth run [--max-memories=N] [--phases=extract,consolidate,models,embed]
//                    [--model=sonnet] [--dry]      one governed synthesis pass
//   johnny synth status [--exit-code]                        what is pending (no model calls)
//   johnny synth resume <extract|consolidate|models|synth>   clear an auto-pause
//   johnny synth jobs                                        job_state table
//   johnny synth reset-knowledge --yes                       drop all DERIVED knowledge (raw memories untouched) to recompile
//   johnny synth install | arm | disarm                      headless LaunchAgent (install writes files only)
//
// `run` is what the scheduler invokes (LaunchAgent -> johnny synth run):
// headless, tool-less Claude via the subscription, no human steps. `status
// --exit-code` is the zero-cost precheck: exit 0 = work pending, exit 75 =
// nothing to do (the scheduler treats 75 as a quiet skip).

import { readKnowledgeConfig } from '../../knowledge/config.js';
import { ClaudeCliSynthesizer, MockSynthesizer, type Synthesizer } from '../../knowledge/synth.js';
import { runSynthesis, synthStatus, formatReport } from '../../knowledge/run.js';
import * as jobs from '../../store/db/jobs.js';
import { log } from '../../utils/log.js';
import * as heartbeat from '../../knowledge/heartbeat.js';

const arg = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const out = (m: string) => process.stdout.write(m + '\n');

export const EXIT_NOTHING_TO_DO = 75;

export async function cmdSynth(args: string[]): Promise<void> {
  // Knowledge tables live in the local store on the Mac (hooks/MCP read it too).
  const [sub = 'status', ...rest] = args;

  if (sub === 'status') {
    const st = await synthStatus();
    out([
      `pending memories to extract  ${st.pendingMemories}`,
      `scopes awaiting consolidation ${st.pendingConsolidateScopes}`,
      `stale models                  ${st.staleModels}`,
      `kicks pending                 ${st.pendingKicks ? 'yes' : 'no'}`,
      `chunks/facts awaiting embedding ${st.pendingEmbeddings}`,
      `paused                        ${st.paused.length ? st.paused.join(', ') : 'none'}`,
      `rate-limit backoff until      ${st.backoffUntil ?? '—'}`,
      `needs work                    ${st.needsWork ? 'YES' : 'no'}`,
    ].join('\n'));
    if (rest.includes('--exit-code')) process.exit(st.needsWork ? 0 : EXIT_NOTHING_TO_DO);
    return;
  }

  if (sub === 'resume') {
    const job = rest[0];
    if (!job) { out('usage: johnny synth resume <extract|consolidate|models|synth>'); process.exit(1); }
    const all = await jobs.listJobs(job);
    for (const j of all.length ? all : [{ job, scope: '' }]) await jobs.resume(j.job, j.scope);
    out(`resumed ${job}`);
    return;
  }

  if (sub === 'jobs') {
    for (const j of await jobs.listJobs()) {
      out(`${j.job}${j.scope ? ':' + j.scope : ''}  paused=${j.paused} fails=${j.fail_count} pending=${j.pending} wm=${j.watermark ?? '—'} ${j.last_error ? 'err=' + j.last_error.slice(0, 80) : ''}`);
    }
    return;
  }

  if (sub === 'reset-knowledge') {
    // Clears DERIVED knowledge only (facts/observations/models/history/job state). Raw memories,
    // chunks and the dedupe ledger are untouched, so a reset just means "recompile from scratch".
    if (!rest.includes('--yes')) { out('this deletes all compiled facts, observations and mental models (raw memories are untouched). re-run with --yes.'); process.exit(1); }
    const { query: q, execute: ex } = await import('../../store/db-client.js');
    for (const t of ['knowledge_history', 'observation_evidence', 'observations', 'mental_models', 'fact_entities', 'facts', 'extraction_log']) await ex(`DELETE FROM ${t}`);
    await ex(`DELETE FROM job_state WHERE job IN ('extract','consolidate','models','synth')`);
    const left = await q<{ n: number }>('SELECT COUNT(*) AS n FROM facts');
    out(`knowledge reset (facts left: ${left[0].n}). the next heartbeat recompiles from the raw memories.`);
    return;
  }

  if (sub === 're-scope' || sub === 'rescope') {
    // Re-home existing facts/observations/models under the current scope rule (idempotent).
    const { rescopeKnowledge } = await import('../../knowledge/rescope.js');
    const r = await rescopeKnowledge();
    out(`rescoped ${r.scopesChanged} scope(s): ${r.facts} facts, ${r.observations} observations, ${r.models} models moved.${r.changes.length ? '\n  ' + r.changes.join('\n  ') : ''}`);
    return;
  }

  if (sub === 'install') {
    const f = heartbeat.installHeartbeatFiles();
    out(`wrote ${f.script}\nwrote ${f.plist}\nnot loaded. arm with: johnny synth arm   (disarm: johnny synth disarm)`);
    return;
  }
  if (sub === 'arm') { await heartbeat.setAutoSynth(true); heartbeat.arm(); out(`armed ${heartbeat.LABEL} (every ${heartbeat.INTERVAL_SECONDS / 3600}h, headless)`); return; }
  if (sub === 'disarm') { await heartbeat.setAutoSynth(false); heartbeat.disarm(); out(`disarmed ${heartbeat.LABEL}`); return; }

  if (sub === 'run') {
    const cfg = await readKnowledgeConfig();
    const model = arg(rest, 'model');
    const synth: Synthesizer = rest.includes('--dry')
      ? new MockSynthesizer(() => '{"windows":[]}')
      : new ClaudeCliSynthesizer({ defaultModel: model ?? cfg.synth.defaultModel, models: cfg.synth.models });
    const phasesArg = arg(rest, 'phases');
    const maxMem = arg(rest, 'max-memories');
    const verbose = rest.includes('--verbose');

    const st = await synthStatus();
    if (!st.needsWork && !rest.includes('--force')) {
      out('nothing pending — skipping (no model calls made).');
      return;
    }

    const report = await runSynthesis({
      synth, config: cfg,
      log: verbose ? m => out('  ' + m) : undefined,
      phases: phasesArg ? (phasesArg.split(',') as never) : undefined,
      maxMemories: maxMem ? Number(maxMem) : undefined,
    });
    const text = formatReport(report);
    out(text);
    await log(`synth run: ${report.stopped} · ${report.extraction.factsAccepted} facts · ${report.consolidation.created} obs · ${report.models.refreshed.length} models refreshed`);

    return;
  }

  out('usage: johnny synth <run|status|resume|jobs|rescope|reset-knowledge|install|arm|disarm>');
  process.exit(1);
}
