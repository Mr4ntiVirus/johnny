import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSnapshot } from '../vendor/cmv/core/metadata-store.js';
import { getCmvSnapshotsDir } from '../vendor/cmv/utils/paths.js';
import { trimJsonl } from '../vendor/cmv/core/trimmer.js';
import { readJsonlLines } from '../utils/jsonl.js';
import { hasMemoryBeenSurfaced, recordMemorySurfaced } from '../store/session-map.js';
import { formatHint, type ScoredMemory } from '../engine/hint.js';
import { logHintEmission } from '../store/db/telemetry.js';
import type { MemoryNode, HookOutput } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';
import { humanDate } from '../utils/human-date.js';

// recommend_memory is by-policy emission: the decision engine already committed
// to a high-confidence match before this action fires. Pass zero thresholds
// to formatHint so any score (or a null by-policy entry) forces Form 3 with
// a 'high' label — re-litigating the band inside the emitter would let
// realistic 0.55–0.77 matches drop into "Possibly relevant memories" prose
// that contradicts the engine's decision. The percentage shown still
// reflects the real cosine value when one exists.
const RECOMMEND_HIGH_THRESHOLD = 0;
const RECOMMEND_NORMAL_THRESHOLD = 0;

// Load-assertion line layered on top of the pure hint emission. recommend_memory
// has actually appended the body to the JSONL transcript (or will at next
// turn) — this confirms that to Claude so it doesn't redundantly call
// johnny_recall for context it already has.
const LOAD_ASSERTION =
  '(Loaded into transcript — full body available from next turn.)';

const CLAUDE_CODE_VERSION = '2.1.114';

// Synthetic transcript frame wrapping a loaded memory body. Verified against
// Claude Code's on-disk JSONL format in Phase 0.5 test A2 — the parser accepts
// this shape without error. Exported for unit testing.
export interface SyntheticFrame {
  opener: Record<string, unknown>;
  ack: Record<string, unknown>;
}

export function buildSyntheticFrame(
  mem: MemoryNode,
  sessionId: string,
  cwd: string,
  now: string = new Date().toISOString(),
  openerUuid: string = randomUUID(),
  ackUuid: string = randomUUID(),
): SyntheticFrame {
  const opener = {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: `[johnny] loaded context: ${mem.snapshotName} — summary: ${mem.summary}. Prior session content follows.`,
    },
    timestamp: now,
    uuid: openerUuid,
    sessionId,
    cwd,
    version: CLAUDE_CODE_VERSION,
  };

  const ack = {
    parentUuid: openerUuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `Acknowledged — context ${mem.snapshotName} loaded. Continuing.` }],
    },
    timestamp: now,
    uuid: ackUuid,
    sessionId,
    version: CLAUDE_CODE_VERSION,
  };

  return { opener, ack };
}

// recommend_memory additionalContext = human-framed opener + Form 3 hint body + load assertion.
export function buildDigest(mem: MemoryNode, topScore: number | null, nowIso?: string): string {
  const date = humanDate(mem.createdAt, nowIso);
  const opener = `loading context from ${date} — ${(mem.summary ?? mem.snapshotName).slice(0, 100).toLowerCase()}`;
  const scored: ScoredMemory[] = [{
    memory: mem,
    score: topScore,
    label: 'high',
  }];
  const emission = formatHint(scored, {
    highThreshold: RECOMMEND_HIGH_THRESHOLD,
    normalThreshold: RECOMMEND_NORMAL_THRESHOLD,
  });
  const body = emission?.text ?? `topics: ${mem.topics.slice(0, 6).join(', ')}`;
  return `${opener}\n\n${body}\n${LOAD_ASSERTION}`;
}

// Append lines to an existing JSONL file. Non-atomic — we're appending in
// place, not rewriting.
export async function appendMemoryEntriesIfTranscriptExists(
  transcriptPath: string,
  entries: unknown[],
): Promise<'appended' | 'skipped-no-transcript'> {
  try {
    await fs.access(transcriptPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return 'skipped-no-transcript';
    throw err;
  }
  const content = entries.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.appendFile(transcriptPath, content, 'utf-8');
  return 'appended';
}

// Load the trimmed body of a memory's CMV snapshot as raw JSONL lines (no
// synthetic wrapping). Separated from entry-wrapping so callers can extract
// excerpts from the same body lines they're about to append — reading disk
// only once.
export async function loadTrimmedMemoryBody(mem: MemoryNode): Promise<unknown[]> {
  const cmvSnap = await getSnapshot(mem.snapshotName);

  let effectiveJsonl: string;

  if (cmvSnap) {
    const snapJsonl = path.join(
      getCmvSnapshotsDir(),
      cmvSnap.snapshot_dir,
      'session',
      `${cmvSnap.source_session_id}.jsonl`,
    );
    const localExists = await fs.access(snapJsonl).then(() => true).catch(() => false);
    if (!localExists) throw new Error(`snapshot file missing locally: ${mem.snapshotName}`);
    effectiveJsonl = snapJsonl;
  } else {
    throw new Error(`snapshot not found: ${mem.snapshotName}`);
  }

  const trimmedTmp = effectiveJsonl + '.johnny-ss-trim.tmp';
  try {
    await trimJsonl(effectiveJsonl, trimmedTmp, {});
    return await readJsonlLines(trimmedTmp);
  } catch {
    return await readJsonlLines(effectiveJsonl);
  } finally {
    await fs.rm(trimmedTmp, { force: true });
  }
}

export function wrapBodyWithSyntheticFrame(
  mem: MemoryNode,
  bodyLines: unknown[],
  sessionId: string,
  cwd: string,
): unknown[] {
  const { opener, ack } = buildSyntheticFrame(mem, sessionId, cwd);
  return [opener, ...bodyLines, ack];
}

// Convenience: load + wrap in one call. Kept for callers (recommendMemory) that
// don't need the raw body separately.
export async function buildMemoryBodyEntries(
  mem: MemoryNode,
  sessionId: string,
  cwd: string,
): Promise<unknown[]> {
  const body = await loadTrimmedMemoryBody(mem);
  return wrapBodyWithSyntheticFrame(mem, body, sessionId, cwd);
}

// Append lines to an existing JSONL file. Non-atomic — we're appending in
// place, not rewriting. On turn 1 of a fresh session the transcript may not
// exist yet; the caller guards against that by skipping the append.
async function appendJsonlLines(targetPath: string, lines: unknown[]): Promise<void> {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.appendFile(targetPath, content, 'utf-8');
}

export async function recommendMemory(
  prompt: string,
  mem: MemoryNode,
  transcriptPath: string,
  sessionId: string,
  cwd: string,
  topScore: number | null = null,
): Promise<HookOutput> {
  const alreadySurfaced = await hasMemoryBeenSurfaced(sessionId, mem.id);

  const date = humanDate(mem.createdAt);
  const topics = mem.topics.slice(0, 3).join(', ');
  const line1 = neon.cyan('⇌') + ink.fg(`  ${date}`) + dim.fg(` — ${topics}`);
  const line2 = dim.fg(`  ${(mem.summary ?? mem.snapshotName).slice(0, 100)}`);
  const stderrLines = `${line1}\n${line2}`;

  // Already in the transcript from a prior turn — no re-inject needed.
  // Model will see the body directly; additionalContext would be redundant.
  if (alreadySurfaced) {
    await log(`recommend: ${mem.snapshotName} already in transcript, skipping re-injection`);
    return { systemMessage: stderrLines };
  }

  // Current turn: model sees the digest via additionalContext.
  // Next turn onward: model sees the full body because we append it to JSONL.
  try {
    const entries = await buildMemoryBodyEntries(mem, sessionId, cwd);

    // Check transcript exists before appending. On fresh-session turn 1 it may
    // not — in that case, skip the JSONL append and rely on additionalContext
    // alone for the current turn (sticky re-injection can catch up next turn).
    try {
      await fs.access(transcriptPath);
      await appendJsonlLines(transcriptPath, entries);
      await recordMemorySurfaced(sessionId, mem.id);
      await log(`recommend: ${mem.snapshotName} digest injected, ${entries.length} body lines appended`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        await log(`recommend: ${mem.snapshotName} digest injected, transcript not yet written — skipping append`);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // "snapshot not found" is a benign fallback — the memory exists in the
    // graph but its CMV body isn't on disk (e.g. imported/seeded memory).
    // The digest still flows via additionalContext; log accordingly.
    const msg = String(err);
    if (msg.includes('snapshot not found')) {
      await log(`recommend: ${mem.snapshotName} body unavailable on disk — digest-only injection`);
    } else {
      await log(`recommend: body-append failed (${err}) — digest-only fallback`);
    }
  }

  const additionalContext = buildDigest(mem, topScore);
  logHintEmission({
    sessionId,
    form: 'recommend_memory',
    suggestedMemoryIds: [mem.id],
    topScore: topScore ?? undefined,
    tokenEstimate: Math.ceil(additionalContext.length / 4),
    promptExcerpt: prompt,
  });

  return {
    additionalContext,
    systemMessage: stderrLines,
  };
}
