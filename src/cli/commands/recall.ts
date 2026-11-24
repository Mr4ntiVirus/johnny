// `johnny recall [query]`         — surface best matching memory for Claude to use
// `johnny recall --switch [query]` — full JSONL hard-switch to matching memory
// `johnny recall --list`           — list all memories ranked by score
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readGraph } from '../../store/graph.js';
import { readState } from '../../store/state.js';
import { readConfig } from '../../store/config.js';
import { rankBySimilarity } from '../../engine/embedder.js';
import { getSnapshot } from '../../vendor/cmv/core/metadata-store.js';
import { getCmvSnapshotsDir } from '../../vendor/cmv/utils/paths.js';
import { getLatestSession, getSessionJsonlPath } from '../../vendor/cmv/core/session-reader.js';
import { trimJsonl } from '../../vendor/cmv/core/trimmer.js';
import { atomicWriteJsonl, readJsonlLines } from '../../utils/jsonl.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';
import type { Memory, MemoryFull, SummaryEntry } from '../../types.js';
import * as transcriptsDb from '../../store/db/transcripts.js';
import * as memoriesDb from '../../store/db/memories.js';
import { PATHS } from '../../store/paths.js';
import { writeFileSync } from 'node:fs';

function keywordMatch(query: string, mem: Memory): number {
  const tokens = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 2));
  const hits = mem.topics.filter(t => tokens.has(t)).length
    + (tokens.has(mem.snapshotName.toLowerCase()) ? 2 : 0);
  return hits / Math.max(tokens.size, 1);
}

async function getTranscriptForMemory(memoryId: string): Promise<string | null> {
  return transcriptsDb.getTranscriptText(memoryId);
}

async function findBestMatch(
  query: string,
  memories: Memory[],
  currentTurn: number,
  config: Awaited<ReturnType<typeof readConfig>>,
): Promise<{ memory: Memory; similarity: number; method: string } | null> {
  if (memories.length === 0) return null;

  // Try embedding similarity first
  const embedded = memories.filter(m => m.embedding !== null);
  if (embedded.length > 0) {
    try {
      const ranked = await rankBySimilarity(query, memories, 1);
      if (ranked.length > 0 && ranked[0].similarity > 0.4) {
        return { memory: ranked[0].memory, similarity: ranked[0].similarity, method: 'embedding' };
      }
    } catch { /* Ollama offline — fall through to keyword */ }
  }

  // Keyword fallback
  const scored = memories
    .map(m => ({ m, score: keywordMatch(query, m) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0 && scored[0].score > 0) {
    return { memory: scored[0].m, similarity: scored[0].score, method: 'keyword' };
  }
  return null;
}

async function doSwitch(targetMemory: Memory, currentTurn: number): Promise<void> {
  const session = await getLatestSession();
  if (!session) {
    process.stdout.write(neon.red('× no active session found\n'));
    process.exit(1);
  }
  const transcriptPath = getSessionJsonlPath(session);

  const cmvSnap = await getSnapshot(targetMemory.snapshotName);
  if (!cmvSnap) {
    process.stdout.write(neon.red(`× snapshot "${targetMemory.snapshotName}" not found\n`));
    process.exit(1);
  }

  const snapJsonl = path.join(
    getCmvSnapshotsDir(),
    cmvSnap.snapshot_dir,
    'session',
    `${cmvSnap.source_session_id}.jsonl`,
  );

  const trimmedTmp = transcriptPath + '.johnny-recall.tmp';
  try {
    await trimJsonl(snapJsonl, trimmedTmp, {});
  } catch {
    await fs.copyFile(snapJsonl, trimmedTmp);
  }

  const trimmedLines = await readJsonlLines(trimmedTmp);
  await fs.rm(trimmedTmp, { force: true });

  const boundary: SummaryEntry = {
    type: 'summary',
    summary: `Recalled context: ${targetMemory.summary}. Loaded at turn ${currentTurn}.`,
    timestamp: new Date().toISOString(),
  };

  await atomicWriteJsonl(transcriptPath, [boundary, ...trimmedLines]);
  await log(`recall --switch: swapped to ${targetMemory.snapshotName}`);

  process.stdout.write(neon.magenta(`⟳ switched · ${targetMemory.snapshotName}\n`));
  process.stdout.write(dim.fg('  takes effect next turn\n'));
}

export async function cmdRecall(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      `\n  ${neon.cyan('johnny recall')} — search and surface a memory\n\n` +
      `  ${dim.fg('usage:')}\n` +
      `    johnny recall <query>            ${dim.fg('# find best matching memory')}\n` +
      `    johnny recall --list             ${dim.fg('# list top memories by score')}\n` +
      `    johnny recall --switch <query>   ${dim.fg('# hard-switch JSONL to matching memory')}\n` +
      `    johnny recall --help             ${dim.fg('# this message')}\n`,
    );
    return;
  }

  await runRecall(args);
}

async function runRecall(args: string[]): Promise<void> {
  const switchMode = args.includes('--switch');
  const listMode  = args.includes('--list');
  const queryArgs = args.filter(a => !a.startsWith('--'));
  const query     = queryArgs.join(' ').trim();

  const [graph, state, config] = await Promise.all([readGraph(), readState(), readConfig()]);
  const memories = Object.values(graph.memories) as Memory[];
  const currentTurn = state.turnCounter;

  if (memories.length === 0) {
    process.stdout.write(dim.fg('  nothing in the wetware yet\n'));
    return;
  }

  // --list: show all memories, most-recently-retrieved first
  if (listMode) {
    const totalMemories = await memoriesDb.getMemoryCount();
    const displayRecords = await memoriesDb.listMemoriesForDisplay(20);
    const topicsByMem = await transcriptsDb.getAllTopicsByMemory();

    process.stdout.write('\n');
    process.stdout.write(neon.cyan(`  showing ${displayRecords.length} of ${totalMemories} subjects in the wetware`));
    process.stdout.write(dim.fg('  via '));
    process.stdout.write(neon.green('⚡ local\n'));
    process.stdout.write(dim.fg('  ─────────────────────────────────────────────\n'));
    for (const [i, rec] of displayRecords.entries()) {
      const dormantTurns = currentTurn - (rec.last_retrieved_turn ?? 0);
      const age = rec.retrieval_count > 0 ? `${dormantTurns}t ago` : 'never retrieved';
      const title = rec.title.length > 50 ? rec.title.slice(0, 47) + '...' : rec.title;
      const topics = topicsByMem.get(rec.id) ?? [];
      process.stdout.write(`  ${String(i + 1).padEnd(3)} ${neon.cyan(title.padEnd(50))} ${dim.fg(age)}\n`);
      process.stdout.write(dim.fg(`       ${topics.slice(0, 6).join(', ')}\n`));
    }
    process.stdout.write('\n');
    process.stdout.write(dim.fg('  usage: /recall <query> · /recall --switch <query>\n'));
    return;
  }

  if (!query) {
    process.stdout.write(dim.fg('  usage: /recall <query>  ·  /recall --list  ·  /recall --switch <query>\n'));
    return;
  }

  // Load embeddings for ALL memories — topCandidates(30) was rank-biased and made
  // new/low-rank memories invisible to recall queries (chicken-and-egg: they can't
  // gain rank if they can never surface). Cost: ~1 DB round-trip for embedding blobs.
  const candidates = memories;
  const embeddingMap = await transcriptsDb.getEmbeddingsByIds(candidates.map(c => c.id));
  for (const c of candidates) {
    const emb = embeddingMap.get(c.id);
    if (emb) (c as import('../../types.js').MemoryFull).embedding = emb;
  }

  const match = await findBestMatch(query, candidates as Memory[], currentTurn, config);
  if (!match) {
    process.stdout.write(neon.amber(`  no match for "${query}"\n`));
    process.stdout.write(dim.fg('  try: /recall --list to see all subjects\n'));
    return;
  }

  const { memory: mem, similarity, method } = match;
  const dormantTurns = currentTurn - mem.lastRetrievedTurn;
  const age = mem.lastRetrievedTurn > 0 ? `${dormantTurns}t ago` : 'never retrieved';
  const topEdges = Object.entries(mem.outgoingEdges)
    .sort(([, a], [, b]) => b.weight - a.weight)
    .slice(0, 3)
    .map(([toId, edge]) => {
      const to = graph.memories[toId];
      return to ? `${to.snapshotName.slice(0, 20)} (w=${(edge.weight ?? 0).toFixed(1)})` : null;
    })
    .filter(Boolean);

  if (switchMode) {
    await doSwitch(mem, currentTurn);
    return;
  }

  // Soft recall: surface memory content for Claude to consume
  const transcript = await getTranscriptForMemory(mem.id);

  // Persist last recall event so doctor can show it as proof of path activity.
  try {
    writeFileSync(PATHS.lastRecall, JSON.stringify({
      query,
      match: mem.snapshotName,
      similarity: Math.round(similarity * 100),
      method,
      source: 'local-sqlite',
      ts: new Date().toISOString(),
    }));
  } catch { /* non-fatal */ }

  process.stdout.write('\n');
  process.stdout.write(neon.cyan(`◈ ${mem.snapshotName}`));
  process.stdout.write(dim.fg(` · ${(similarity * 100).toFixed(0)}% match · ${method} · `));
  process.stdout.write(neon.green('⚡ local\n'));
  process.stdout.write(dim.fg('  ─────────────────────────────────────────────\n'));
  process.stdout.write(ink.fg(`  ${mem.summary}\n`));
  process.stdout.write(dim.fg(`  topics:    ${mem.topics.slice(0, 8).join(', ')}\n`));
  process.stdout.write(dim.fg(`  rank:      ${mem.rank.toFixed(3)} · activation: ${(Math.exp(-(currentTurn - mem.lastRetrievedTurn) / config.activationTau)).toFixed(3)}\n`));
  process.stdout.write(dim.fg(`  retrieved: ${mem.retrievalCount} times · last ${age}\n`));
  if (topEdges.length > 0) {
    process.stdout.write(dim.fg(`  linked:    ${topEdges.join(' · ')}\n`));
  }
  
  if (transcript) {
    process.stdout.write('\n');
    process.stdout.write(dim.fg('  transcript:\n'));
    const lines = transcript.split('\n').slice(0, 30);
    for (const line of lines) {
      process.stdout.write(ink.fg(`    ${line}\n`));
    }
    if (transcript.split('\n').length > 30) {
      process.stdout.write(dim.fg('    ... (truncated, use --switch to load full context)\n'));
    }
  }
  
  process.stdout.write('\n');
  process.stdout.write(dim.fg(`  load it: /recall --switch ${query}\n`));
}
