// Embeds any memories whose transcript row has a NULL embedding vector, and
// any chunks left with embedding=null — either Ollama was offline when
// chunkAndPersistMemory ran, or its wall-clock deadline was hit mid-batch on
// a large snapshot (see chunker.ts's `deadline` option). Runs on a timer so
// embedding is decoupled from the hot hook path — even if a UserPromptSubmit
// hook times out or bails early, this catches it.
import { query } from '../store/db-client.js';
import { embed, getEmbedModelName } from '../utils/llm.js';
import { setEmbedding } from '../store/db/transcripts.js';
import { getChunksNeedingEmbedding, setChunkEmbedding } from '../store/db/chunks.js';
import { truncateForEmbedding } from '../engine/chunker.js';
import { recordHeartbeat } from '../store/db/heartbeats.js';
import { log } from '../utils/log.js';

const BACKFILL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 20;

let backfillTimer: ReturnType<typeof setTimeout> | null = null;

async function runBackfill(): Promise<void> {
  const rows = await query<{ id: string; summary: string | null; topics: string | null }>(
    `SELECT m.id, m.summary, t.topics
     FROM memories m
     JOIN transcripts t ON t.memory_id = m.id
     WHERE t.embedding IS NULL
     LIMIT ?`,
    [BATCH_SIZE],
  );

  if (rows.length > 0) {
    await log(`embed-backfill: ${rows.length} memories need embedding`);
    for (const row of rows) {
      try {
        const topicsArr: string[] = row.topics ? JSON.parse(row.topics) : [];
        const text = [row.summary ?? '', ...topicsArr].join(' ').trim();
        const vec = await embed(text);
        await setEmbedding(row.id, vec, getEmbedModelName());
      } catch (e) {
        await log(`embed-backfill: failed to embed ${row.id} — ${e}`);
      }
    }
    await log(`embed-backfill: batch complete`);
  }

  const chunkRows = await getChunksNeedingEmbedding(BATCH_SIZE);
  if (chunkRows.length > 0) {
    await log(`embed-backfill: ${chunkRows.length} chunks need embedding`);
    const modelName = getEmbedModelName();
    for (const row of chunkRows) {
      try {
        const vec = await embed(truncateForEmbedding(row.text));
        await setChunkEmbedding(row.chunk_id, vec, modelName);
      } catch (e) {
        await log(`embed-backfill: failed to embed chunk ${row.chunk_id} — ${e}`);
      }
    }
    await log(`embed-backfill: chunk batch complete`);
  }

  recordHeartbeat('embed-backfill', { didWork: rows.length > 0 || chunkRows.length > 0 });
}

export function startEmbedBackfill(): void {
  const tick = async () => {
    try { await runBackfill(); } catch (e) { await log(`embed-backfill ERROR: ${e}`); }
    backfillTimer = setTimeout(tick, BACKFILL_INTERVAL_MS);
  };
  // First run after a short delay so the daemon pool settles before querying.
  backfillTimer = setTimeout(tick, 30_000);
}

export function stopEmbedBackfill(): void {
  if (backfillTimer) { clearTimeout(backfillTimer); backfillTimer = null; }
}
