import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getCmvSnapshotsDir } from '../vendor/cmv/utils/paths.js';
import { createSnapshot } from '../vendor/cmv/core/snapshot-manager.js';
import { analyzeSession } from '../utils/analysis-cache.js';
import { addMemory } from '../store/memory.js';
import { embedMemory } from '../engine/embedder.js';
import { chunkAndPersistMemory, countNovelChunks } from '../engine/chunker.js';
import { summarizeSession } from '../engine/summarizer.js';
import { checkSnapshotNovelty } from '../engine/novelty-gate.js';
import { readConfig } from '../store/config.js';
import * as edgesDb from '../store/db/edges.js';
import * as memoriesDb from '../store/db/memories.js';
import {
  getRecalledMemoryIds, clearRecalledMemoryIds, getLastSnapshotLine, setLastSnapshotLine,
  getLastSnapshotUuid, setLastSnapshotUuid,
} from '../store/db/sessions.js';
import { getLedgeredUuids, recordLedger } from '../store/db/snapshot-ledger.js';
import { computeDelta } from './snapshot-delta.js';
import { toStagePlayFormat, getUserDisplayName } from '../utils/transcript.js';
import { logError } from '../store/db/error-telemetry.js';
import type { HookOutput } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';

function extractTopics(summary: string): string[] {
  return summary
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter(w => w.length > 3)
    .slice(0, 20);
}

export async function snapshot(
  transcriptPath: string,
  sessionId: string,
  projectPath: string,
  currentTurn: number,
  silent = false,
  // Absolute Date.now()-based deadline for the chunk-embedding step (see
  // chunker.ts's ChunkOptions.deadline). Passed by evaluate.ts's interactive
  // hook so a large one-off backlog can't blow the caller's own timeout;
  // post-turn.ts's background path omits it (unbounded).
  embedDeadline?: number,
): Promise<{ output: HookOutput; snapshotName: string | null; memoryId: string | null }> {
  try {
    // Delta first (cheap, no LLM): content-addressed by message uuid so trims,
    // compaction rewrites and resumed-session copies can't make us re-capture
    // history (see snapshot-delta.ts). Everything below works on the delta only.
    const allLines = (await fs.readFile(transcriptPath, 'utf-8'))
      .split('\n')
      .filter(l => l.trim());
    const [anchorUuid, legacyLineCursor] = await Promise.all([
      getLastSnapshotUuid(sessionId),
      getLastSnapshotLine(sessionId),
    ]);
    const delta = await computeDelta(allLines, {
      anchorUuid, legacyLineCursor, lookupLedger: getLedgeredUuids,
    });

    // Advance both cursors without creating a memory (nothing new / all duplicate).
    const advanceCursors = async () => {
      try {
        if (delta.lastUuid) await setLastSnapshotUuid(sessionId, delta.lastUuid);
        await setLastSnapshotLine(sessionId, allLines.length);
      } catch (cursorErr) {
        await log(`snapshot: failed to advance delta cursor — next snapshot may overlap: ${cursorErr}`);
      }
    };

    if (!delta.hasMessages) {
      await log(`snapshot: skipped (no new messages since last snapshot; ${delta.alreadySeen} already captured)`);
      await advanceCursors();
      return { output: {}, snapshotName: null, memoryId: null };
    }

    const [analysis, sessionSummary] = await Promise.all([
      analyzeSession(transcriptPath),
      summarizeSession(transcriptPath, { rawContent: delta.deltaLines.join('\n') }),
    ]);
    const name = sessionSummary.slug;
    const summary = sessionSummary.summary;
    const title = sessionSummary.title;

    const config = await readConfig();
    const verdict = await checkSnapshotNovelty(summary, sessionId, config.snapshotNoveltyThreshold);
    if (verdict.redundant) {
      await log(`snapshot: skipped (novelty sim=${verdict.similarity.toFixed(3)} ≥ ${config.snapshotNoveltyThreshold} vs ${verdict.priorSnapshotName})`);
      // Intentionally don't clear sessions.recalled_memory_ids here: no child
      // memory was born, so the recall set rolls forward to the next snapshot
      // that does land.
      return { output: silent ? {} : {}, snapshotName: null, memoryId: null };
    }

    const snapResult = await createSnapshot({
      name,
      sessionId,
      description: summary,
      tags: ['johnny-auto'],
    });

    // Local source URI: the snapshot's session transcript inside the CMV snapshots dir.
    const sourceUri = `file://${path.join(getCmvSnapshotsDir(), snapResult.snapshot.id, 'session', `${sessionId}.jsonl`)}`;

    // Delta transcript: only the new JSONL lines (computed above) — each memory
    // holds only the work that motivated it.
    const rawTranscript = delta.deltaLines.join('\n');
    const transcriptContent = toStagePlayFormat(rawTranscript, { userName: getUserDisplayName() });

    // Second, independent guard: if every chunk of this delta already exists in
    // the store (e.g. a continuation summary or re-pasted block), don't mint a
    // memory that would only hold duplicates. Record the uuids so they aren't
    // reconsidered, and move on.
    const novelChunks = await countNovelChunks(transcriptContent);
    if (novelChunks === 0) {
      await log('snapshot: skipped (every chunk already stored)');
      try { await recordLedger(delta.newUuids, sessionId, null); } catch { /* best-effort */ }
      await advanceCursors();
      return { output: {}, snapshotName: null, memoryId: null };
    }

    const mem = await addMemory(
      name,
      title,
      summary,
      transcriptContent,
      projectPath,
      analysis.estimatedTokens,
      extractTopics(summary),
      currentTurn,
      sourceUri,
    );

    // Best-effort: embed memory for Phase 3 similarity search (skip silently if Ollama offline)
    try { await embedMemory(mem); } catch (err) {
      logError({ source: 'embed', severity: 'warning', message: `snapshot embed failed: ${err}`, sessionId });
    }

    // Phase G: chunk + embed transcript for Mosaic Recall. Chunks are
    // independently scored at pull time; their absence degrades recall but
    // never blocks snapshotting. Daemon backfill is a follow-up concern.
    try {
      const result = await chunkAndPersistMemory(mem.id, name, transcriptContent, { deadline: embedDeadline });
      await log(`chunks: ${name} → ${result.count} chunks (${result.embedded} embedded, ${result.skipped} skipped)`);
    } catch (err) {
      await log(`chunks ERROR: ${name} → ${err}`);
      logError({ source: 'chunk', severity: 'error', message: String(err).slice(0, 300), sessionId });
    }

    // Record the captured uuids in the global ledger and advance both cursors
    // (anchor uuid + legacy line count). Defensive: the memory is already
    // persisted, so a missed cursor advance is preferable to a missed memory.
    try {
      await recordLedger(delta.newUuids, sessionId, mem.id);
    } catch (ledgerErr) {
      await log(`snapshot: failed to record ledger — next snapshot may overlap: ${ledgerErr}`);
    }
    await advanceCursors();

    // Phase G: provenance edges. Read the session's recall set (memories whose
    // chunks Claude pulled to build this snapshot) and wire bidirectional
    // derived_from edges, then clear the set so the next snapshot in this
    // session inherits only its own recalls.
    try {
      const rawParentIds = await getRecalledMemoryIds(sessionId);
      const parentIds = (await Promise.all(
        rawParentIds.filter(id => id !== mem.id).map(async id => ({ id, exists: !!(await memoriesDb.getMemory(id)) })),
      )).filter(r => r.exists).map(r => r.id);
      if (parentIds.length > 0) {
        await edgesDb.createDerivedFromEdges(
          mem.id,
          parentIds,
          currentTurn,
          config.derivedFromInitialWeight,
          config.topKOutgoing,
        );
        await log(`provenance: ${name} ← ${parentIds.length} parent${parentIds.length === 1 ? '' : 's'} (derived_from)`);
      }
      await clearRecalledMemoryIds(sessionId);
    } catch (err) {
      await log(`provenance ERROR: ${name} → ${err}`);
      logError({ source: 'provenance', severity: 'error', message: String(err).slice(0, 300), sessionId });
    }

    await log(`snapshot: created ${name} (${Math.round(analysis.contextUsedPercent)}% context)`);
    const line1 = neon.cyan('◈') + ink.fg(' snapshot saved') + neon.cyan(` · ${name}`);
    const line2 = dim.fg(`  ${summary.slice(0, 100)}`);
    const output: HookOutput = silent
      ? {}
      : { systemMessage: `${line1}\n${line2}` };

    return { output, snapshotName: name, memoryId: mem.id };
  } catch (err) {
    const msg = String(err);
    // Benign: CMV already has this snapshot name for this minute. Self-correcting —
    // cursor doesn't advance, next snapshot picks up the same delta plus more.
    if (msg.includes('already exists')) {
      logError({ source: 'snapshot', severity: 'benign', message: 'CMV slug collision — already exists', sessionId });
      return { output: silent ? {} : {}, snapshotName: null, memoryId: null };
    }
    // Benign: memories table already has this slug (prior session collision).
    // SQLite emits 'UNIQUE constraint failed'; Postgres emits 'duplicate key value violates unique constraint'.
    if (msg.includes('UNIQUE constraint failed: memories.snapshot_name') ||
        (msg.includes('duplicate key value violates unique constraint') && msg.includes('memories_snapshot_name'))) {
      await log(`snapshot: skipped (slug collision in memories table — ${msg})`);
      logError({ source: 'snapshot', severity: 'benign', message: 'memories.snapshot_name UNIQUE collision', sessionId });
      return { output: silent ? {} : {}, snapshotName: null, memoryId: null };
    }
    await log(`snapshot ERROR: ${err}`);
    logError({ source: 'snapshot', severity: 'error', message: String(err).slice(0, 300), sessionId });
    return { output: { systemMessage: neon.red('×') + dim.fg(` snapshot failed · ${err}`) }, snapshotName: null, memoryId: null };
  }
}
