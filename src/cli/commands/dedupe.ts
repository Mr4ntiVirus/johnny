// johnny dedupe — one-time historical duplicate purge (plus a safe re-runnable
// maintenance command). See src/maintenance/dedupe.ts for the algorithm.
//
//   johnny dedupe                         dry run on the local store (backfills hashes, prints the plan)
//   johnny dedupe --apply                 backup -> purge -> verify -> recompute rank -> VACUUM
//
// Safety rails (apply mode): refuses to run while the daemon is up or hooks are
// enabled, always takes a consistent SQLite backup first, verifies
// invariants afterwards and exits non-zero with restore instructions on failure.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATHS } from '../../store/paths.js';
import { readDaemonPid } from '../../utils/pid.js';
import { isPidAlive } from '../../utils/pid.js';
import {
  backfillHashes, planDedupe, applyDedupe, purgeMemories, verifyDedupe, checkInvariants,
  type DedupePlan,
} from '../../maintenance/dedupe.js';

const log = (m: string) => process.stdout.write(m + '\n');
const arg = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

function describePlan(plan: DedupePlan): string {
  const pct = plan.totalChunks ? ((plan.duplicateChunkIds.length / plan.totalChunks) * 100).toFixed(1) : '0';
  return [
    `chunks              ${plan.totalChunks}`,
    `distinct texts      ${plan.distinctHashes}`,
    `duplicate chunks    ${plan.duplicateChunkIds.length} (${pct}%)`,
    `memories kept       ${plan.keptMemories}`,
    `memories to purge   ${Object.keys(plan.purge).length}   (held only duplicate chunks)`,
  ].join('\n');
}

async function applyLocal(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const { getDatabase } = await import('../../store/database.js');

  log('hashing chunks…');
  const hashed = await backfillHashes(n => { if (n % 20000 === 0) log(`  hashed ${n}`); });
  log(`hashed ${hashed} chunks`);
  const plan = await planDedupe();
  log('\n' + describePlan(plan));
  if (!apply) { log('\ndry run — nothing deleted. re-run with --apply (daemon stopped, hooks disabled).'); return; }

  // ── safety rails ──
  const pid = await readDaemonPid();
  if (pid && isPidAlive(pid) && !args.includes('--force-live')) {
    log(`\nrefusing: daemon is running (pid ${pid}). Stop it (johnny daemon stop) so sync cannot resurrect deleted memories.`);
    process.exit(2);
  }
  if (!fs.existsSync(PATHS.disabled) && !args.includes('--force-live')) {
    log('\nrefusing: hooks are enabled. Run `johnny disable` first so no session writes mid-purge.');
    process.exit(2);
  }

  // ── backup ──
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${PATHS.database}.pre-dedupe-${stamp}`;
  log(`\nbacking up to ${backup} …`);
  await getDatabase().backup(backup);
  log(`backup done (${(fs.statSync(backup).size / 1e9).toFixed(2)} GB)`);

  // Persist the mapping BEFORE deleting so the Postgres run can be driven from it.
  const mappingFile = path.join(path.dirname(PATHS.database), `dedupe-purge-${stamp}.json`);
  fs.writeFileSync(mappingFile, JSON.stringify({ createdAt: new Date().toISOString(), purge: plan.purge }));
  log(`wrote purge mapping ${mappingFile}`);

  log('\napplying…');
  const res = await applyDedupe(plan, m => log('  ' + m));
  log(`\ndeleted ${res.deletedChunks} chunks · purged ${res.purgedMemories} memories · merged ${res.mergedEdges} edges (${res.droppedEdges} self-loops dropped)`);

  const v = await verifyDedupe();
  const problems = checkInvariants(v);
  log(`\nafter: ${v.chunks} chunks / ${v.distinctChunkTexts} distinct · ${v.memories} memories · ${v.orphanEdges} orphan edges`);
  if (problems.length > 0) {
    log('\nINVARIANT FAILURES:\n  - ' + problems.join('\n  - '));
    log(`restore with: cp "${backup}" "${PATHS.database}"   (stop the daemon first, remove -wal/-shm)`);
    process.exit(3);
  }

  log('\nrecomputing PageRank…');
  const { readGraph, writeGraph, recomputePageRank } = await import('../../store/graph.js');
  const { readConfig } = await import('../../store/config.js');
  const { readState } = await import('../../store/state.js');
  const graph = await readGraph();
  recomputePageRank(graph, await readConfig(), (await readState()).turnCounter);
  await writeGraph(graph);

  log('checkpointing + VACUUM (reclaims disk)…');
  const d = getDatabase();
  d.pragma('wal_checkpoint(TRUNCATE)');
  d.exec('VACUUM');
  log(`done. database is now ${(fs.statSync(PATHS.database).size / 1e9).toFixed(2)} GB`);
}

export async function cmdDedupe(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    log('usage: johnny dedupe [--apply] [--force-live]');
    return;
  }
  return applyLocal(args);
}
