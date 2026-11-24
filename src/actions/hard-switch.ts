import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { getSnapshot } from '../vendor/cmv/core/metadata-store.js';
import { getCmvSnapshotsDir } from '../vendor/cmv/utils/paths.js';
import { trimJsonl } from '../vendor/cmv/core/trimmer.js';
import { atomicWriteJsonl, readJsonlLines } from '../utils/jsonl.js';
import { snapshot as takeSnapshot } from './snapshot.js';
import type { MemoryNode, HookOutput, SummaryEntry } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';
import { humanDate } from '../utils/human-date.js';

function buildOrientation(prompt: string, mem: MemoryNode): string {
  const date = humanDate(mem.createdAt);
  return [
    `switching context to ${date} — ${(mem.summary ?? mem.snapshotName).slice(0, 120).toLowerCase()}`,
    `topics: ${mem.topics.slice(0, 8).join(', ')}`,
    `your current prompt will be answered in that context starting next turn.`,
    `prompt: "${prompt.substring(0, 150)}"`,
  ].join('\n');
}

export async function hardSwitch(
  transcriptPath: string,
  sessionId: string,
  projectPath: string,
  prompt: string,
  targetMemory: MemoryNode,
  currentTurn: number,
): Promise<HookOutput> {
  try {
    // Step 1: snapshot current session (safety — never destroy without saving)
    await takeSnapshot(transcriptPath, sessionId, projectPath, currentTurn, true);

    // Step 2: find target snapshot JSONL
    const cmvSnap = await getSnapshot(targetMemory.snapshotName);

    let snapJsonl: string;
    let tmpPath: string | null = null;

    if (cmvSnap) {
      const localJsonl = path.join(
        getCmvSnapshotsDir(),
        cmvSnap.snapshot_dir,
        'session',
        `${cmvSnap.source_session_id}.jsonl`,
      );
      if (!existsSync(localJsonl)) {
        await log(`hard-switch: snapshot file missing locally: ${localJsonl}`);
        process.stderr.write(`× snapshot file missing: ${targetMemory.snapshotName}\n`);
        return {};
      }
      snapJsonl = localJsonl;
    } else {
      await log(`hard-switch: snapshot "${targetMemory.snapshotName}" not found in CMV index or DB`);
      process.stderr.write(`× snapshot not found: ${targetMemory.snapshotName}\n`);
      return {};
    }

    // Step 3: trim target snapshot to remove bloat (tool results, file history, etc.)
    const trimmedTmp = transcriptPath + '.johnny-hs-trim.tmp';
    try {
      await trimJsonl(snapJsonl, trimmedTmp, {});
    } catch {
      // trimmer failed — use raw snapshot JSONL
      await fs.copyFile(snapJsonl, trimmedTmp);
    }

    // Step 4: build new JSONL
    //   [compaction boundary] + [trimmed snapshot content] + [orientation message]
    const trimmedLines = await readJsonlLines(trimmedTmp);
    await fs.rm(trimmedTmp, { force: true });
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});

    const boundary: SummaryEntry = {
      type: 'summary',
      summary: `Previous context: ${targetMemory.summary}. Resuming at turn ${currentTurn}.`,
      timestamp: new Date().toISOString(),
    };

    const orientation = {
      type: 'user',
      content: buildOrientation(prompt, targetMemory),
      timestamp: new Date().toISOString(),
    };

    // Step 5: atomic swap (lands on next turn per Phase 0 findings)
    await atomicWriteJsonl(transcriptPath, [boundary, ...trimmedLines, orientation]);
    await log(`hard-switch: swapped to ${targetMemory.snapshotName}`);

    const date = humanDate(targetMemory.createdAt);
    const topics = targetMemory.topics.slice(0, 3).join(', ');
    const line1 = neon.magenta('⟳') + ink.fg(`  ${date}`) + dim.fg(` — ${topics}`);
    const line2 = dim.fg(`  ${(targetMemory.summary ?? targetMemory.snapshotName).slice(0, 100)}`);

    // The JSONL swap lands on turn N+1 (confirmed by Phase 0.5 A2 retest).
    // Announce the pending switch via additionalContext so the model understands
    // its transcript is about to change and can give a coherent turn-N response
    // instead of being confused when state shifts underneath it next turn.
    const announce = buildOrientation(prompt, targetMemory);

    return {
      additionalContext: announce,
      systemMessage: `${line1}\n${line2}`,
    };
  } catch (err) {
    await log(`hard-switch ERROR: ${err}`);
    return { systemMessage: neon.red('×') + dim.fg(' hard-switch failed · falling through') };
  }
}
