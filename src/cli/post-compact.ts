import { exitIfBypassed } from '../utils/bypass.js';
import { log } from '../utils/log.js';
import { detectPostCompact } from '../utils/compact-detect.js';
import { readGraph, INTERACTIVE_EDGE_LIMIT } from '../store/graph.js';
import { rankBySimilarity } from '../engine/embedder.js';
import { buildMemoryBodyEntries, appendMemoryEntriesIfTranscriptExists } from '../actions/recommend-memory.js';
import { hasMemoryBeenSurfaced, recordMemorySurfaced } from '../store/session-map.js';
import { clearKnowledgeSurfaced } from '../store/db/sessions.js';

const TOP_K = 2;
const MIN_SIMILARITY = 0.50;
const MIN_SUMMARY_LENGTH = 100;

export async function runPostCompact(): Promise<void> {
  exitIfBypassed();

  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  let payload: { transcript_path?: string; session_id?: string; cwd?: string };
  try { payload = JSON.parse(input); } catch { process.stdout.write('{}'); return; }

  const { transcript_path, session_id, cwd = '' } = payload;
  if (!transcript_path || !session_id) { process.stdout.write('{}'); return; }

  try {
    // Primed knowledge was just compacted out of context: make it eligible to
    // be primed again by the next relevant prompt.
    try { await clearKnowledgeSurfaced(session_id); } catch { /* best-effort */ }

    // PostCompact fires immediately after the compact boundary is written.
    // detectPostCompact will always find isPostCompact=true here — zero user
    // messages after the just-written boundary. We use it purely to extract
    // the summary text.
    const { isPostCompact, summaryText } = await detectPostCompact(transcript_path);
    if (!isPostCompact || summaryText.length < MIN_SUMMARY_LENGTH) {
      process.stdout.write('{}');
      return;
    }

    const graph = await readGraph(INTERACTIVE_EDGE_LIMIT);
    const allMemories = Object.values(graph.memories);
    if (allMemories.length === 0) {
      process.stdout.write('{}');
      return;
    }

    const scored = await rankBySimilarity(summaryText, allMemories, TOP_K);
    const topMatches = scored.filter(s => s.similarity >= MIN_SIMILARITY);

    let injected = 0;
    for (const { memory, similarity } of topMatches) {
      if (await hasMemoryBeenSurfaced(session_id, memory.id)) continue;
      try {
        const entries = await buildMemoryBodyEntries(memory, session_id, cwd);
        const result = await appendMemoryEntriesIfTranscriptExists(transcript_path, entries);
        if (result === 'appended') {
          await recordMemorySurfaced(session_id, memory.id);
          injected++;
          await log(`post-compact: baked ${memory.snapshotName} (sim=${similarity.toFixed(2)})`);
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes('snapshot not found')) {
          await log(`post-compact: ${memory.snapshotName} body unavailable — skip`);
        } else {
          await log(`post-compact WARN: body-append failed for ${memory.snapshotName} — ${err}`);
        }
      }
    }
    await log(`post-compact: ${injected} memory(ies) baked into compact context`);
    process.stdout.write('{}');
  } catch (err) {
    await log(`post-compact ERROR: ${err}`);
    process.stdout.write('{}');
  }
}
