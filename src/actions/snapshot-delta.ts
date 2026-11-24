// Delta computation for session snapshots.
//
// Problem this solves: the old line-number cursor (sessions.last_snapshot_line)
// was zeroed after every trim (post-turn.ts) and could not survive Claude Code's
// resumed sessions, which copy prior history into a NEW session file under a new
// session id with cursor 0. Result: ~83% of all stored chunks were duplicates.
//
// Algorithm — content-addressed instead of position-addressed:
//   1. Parse the JSONL; message-bearing lines carry a `uuid` that Claude Code
//      preserves across trims, compaction rewrites and session resumes.
//   2. Start after this session's anchor uuid if it is still in the file; else
//      (first snapshot after upgrade) fall back to the legacy line cursor.
//   3. Drop every uuid already recorded in the global snapshot_ledger.
//   4. Lines without a uuid (mode / ai-title / last-prompt bookkeeping) are kept
//      only when they sit after the last line that was dropped as already-seen.
//
// Keys on uuid only — never on content hashes — so a false "already seen" can
// never swallow genuinely new content. Chunk-level hash dedup is a separate,
// independent guard (chunker.ts).

export interface ParsedLine {
  raw: string;
  uuid: string | null;
  type: string | null;
}

export interface DeltaResult {
  /** Raw JSONL lines to snapshot (new, never-captured content). */
  deltaLines: string[];
  /** uuids contained in deltaLines — to be written to the ledger once persisted. */
  newUuids: string[];
  /** Last uuid-bearing line in the whole file — the next anchor. */
  lastUuid: string | null;
  /** True when the delta contains at least one real message (user/assistant/system/attachment). */
  hasMessages: boolean;
  /** Diagnostics. */
  alreadySeen: number;
  anchorFound: boolean;
}

const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

export function parseJsonlLines(allLines: string[]): ParsedLine[] {
  return allLines.map(raw => {
    try {
      const o = JSON.parse(raw) as { uuid?: unknown; type?: unknown };
      return {
        raw,
        uuid: typeof o.uuid === 'string' && o.uuid ? o.uuid : null,
        type: typeof o.type === 'string' ? o.type : null,
      };
    } catch {
      return { raw, uuid: null, type: null };
    }
  });
}

export async function computeDelta(
  allLines: string[],
  opts: {
    anchorUuid: string | null;
    legacyLineCursor: number;
    /** Returns the subset of `uuids` already in the global ledger. */
    lookupLedger: (uuids: string[]) => Promise<Set<string>>;
  },
): Promise<DeltaResult> {
  const parsed = parseJsonlLines(allLines);

  let lastUuid: string | null = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i].uuid) { lastUuid = parsed[i].uuid; break; }
  }

  // Where to start scanning.
  let start = 0;
  let anchorFound = false;
  if (opts.anchorUuid) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].uuid === opts.anchorUuid) { start = i + 1; anchorFound = true; break; }
    }
  }
  if (!anchorFound && !opts.anchorUuid && opts.legacyLineCursor > 0 && opts.legacyLineCursor <= parsed.length) {
    // Pre-upgrade session: honour the old cursor exactly once. A cursor past EOF
    // is stale (the file was trimmed) and is ignored — the ledger covers it, so
    // the "cursor past EOF stalls snapshots forever" failure cannot recur.
    start = opts.legacyLineCursor;
  }

  const candidates = parsed.slice(start);
  const candidateUuids = candidates.map(c => c.uuid).filter((u): u is string => !!u);
  const seen = candidateUuids.length > 0 ? await opts.lookupLedger(candidateUuids) : new Set<string>();

  // Last index (within candidates) of a line dropped as already-seen.
  let lastSeenIdx = -1;
  candidates.forEach((c, i) => { if (c.uuid && seen.has(c.uuid)) lastSeenIdx = i; });

  const deltaLines: string[] = [];
  const newUuids: string[] = [];
  let hasMessages = false;
  candidates.forEach((c, i) => {
    if (c.uuid) {
      if (seen.has(c.uuid)) return;
      deltaLines.push(c.raw);
      newUuids.push(c.uuid);
      if (c.type && MESSAGE_TYPES.has(c.type)) hasMessages = true;
    } else {
      // uuid-less line: only keep when it is newer than anything already captured.
      if (i < lastSeenIdx) return;
      deltaLines.push(c.raw);
      if (c.type && MESSAGE_TYPES.has(c.type)) hasMessages = true; // e.g. uuid-less user lines
    }
  });

  return {
    deltaLines, newUuids, lastUuid, hasMessages,
    alreadySeen: seen.size, anchorFound,
  };
}
