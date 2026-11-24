// Detects whether the current UserPromptSubmit fires immediately after a
// context compaction. If so, returns the compact summary text so the caller
// can surface relevant memories before the normal pipeline runs.
//
// Detection logic mirrors the CMV analyzer's compaction-boundary handling:
//   - type:"summary" (older Claude Code format)
//   - type:"system" with subtype:"compact_boundary" (current format)
//
// A compact is "fresh" if the last compact boundary in the JSONL has zero
// user-type messages after it. The current prompt hasn't landed yet, so
// this condition is true on exactly the first UserPromptSubmit post-compact.

import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

export interface CompactDetection {
  isPostCompact: boolean;
  summaryText: string;
}

export async function detectPostCompact(transcriptPath: string): Promise<CompactDetection> {
  let lastCompactSummary: string | null = null;
  let userCountAfterCompact = 0;

  let rl: readline.Interface | undefined;
  try {
    rl = readline.createInterface({ input: createReadStream(transcriptPath) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const isCompact = parsed.type === 'summary' ||
        (parsed.type === 'system' && parsed.subtype === 'compact_boundary');

      if (isCompact) {
        const summary = parsed.summary as string | undefined
          ?? (parsed.content as { text?: string }[] | undefined)?.[0]?.text;
        lastCompactSummary = (typeof summary === 'string' && summary.length > 0) ? summary : null;
        userCountAfterCompact = 0;
      } else if (parsed.type === 'user' && lastCompactSummary !== null) {
        userCountAfterCompact++;
      }
    }
  } catch {
    return { isPostCompact: false, summaryText: '' };
  } finally {
    rl?.close();
  }

  return {
    isPostCompact: lastCompactSummary !== null && userCountAfterCompact === 0,
    summaryText: lastCompactSummary ?? '',
  };
}
