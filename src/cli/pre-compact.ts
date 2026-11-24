import { exitIfBypassed } from '../utils/bypass.js';
import { trim } from '../actions/trim.js';
import { snapshot } from '../actions/snapshot.js';
import { readState } from '../store/state.js';
import { log } from '../utils/log.js';
import * as nodePath from 'node:path';

const MIN_SIZE_BYTES = 600_000; // skip if transcript is small — not worth the overhead

export async function runPreCompact(): Promise<void> {
  exitIfBypassed();

  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  let payload: { transcript_path?: string; session_id?: string; cwd?: string };
  try {
    payload = JSON.parse(input);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const { transcript_path } = payload;
  if (!transcript_path) {
    process.stdout.write('{}');
    return;
  }

  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(transcript_path);
    if (info.size < MIN_SIZE_BYTES) {
      // Small session — skip lossless trim, let Claude compact as-is
      process.stdout.write('{}');
      return;
    }

    // Capture before trimming: trim drops everything before the last compaction
    // boundary, so anything not yet snapshotted would be lost to Johnny. Bounded
    // so the hook can never blow its timeout; the snapshot delta/ledger makes a
    // timeout harmless (the next snapshot simply picks the content up).
    const sid = payload.session_id ?? nodePath.basename(transcript_path, '.jsonl');
    try {
      const state = await readState();
      await Promise.race([
        snapshot(transcript_path, sid, payload.cwd ?? '', state.turnCounter, true, Date.now() + 12_000),
        new Promise<void>(resolve => setTimeout(resolve, 20_000)),
      ]);
    } catch (snapErr) {
      await log(`pre-compact: pre-trim snapshot failed (continuing to trim): ${snapErr}`);
    }

    await log(`pre-compact: trimming ${transcript_path} (${Math.round(info.size / 1024)}k)`);
    await trim(transcript_path);
    process.stdout.write('{}');
  } catch (err) {
    await log(`pre-compact ERROR: ${err}`);
    process.stdout.write('{}');
  }
}
