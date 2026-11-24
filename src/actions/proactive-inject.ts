import * as path from 'node:path';
import { rankBySimilarity } from '../engine/embedder.js';
import { getSnapshot } from '../vendor/cmv/core/metadata-store.js';
import type { Memory, SessionMapEntry } from '../types.js';
import { log } from '../utils/log.js';

export interface InjectResult {
  additionalContext: string;
  injectedIds: string[];
}

const MAX_INJECT = 3;
const MAX_CHARS = 1800;
const EMBED_THRESHOLD = 0.45;
const KEYWORD_THRESHOLD = 0.08;

function keywordScore(prompt: string, memory: Memory): number {
  const lower = prompt.toLowerCase();
  const terms = [
    ...memory.topics,
    ...memory.snapshotName.split(/[-_\s]+/),
  ].map(t => t.toLowerCase()).filter(t => t.length > 3);
  if (terms.length === 0) return 0;
  return terms.filter(t => lower.includes(t)).length / terms.length;
}

async function snapshotReadPath(snapshotName: string): Promise<string | null> {
  try {
    const snap = await getSnapshot(snapshotName);
    if (!snap) return null;
    return path.join(snap.snapshot_dir, 'session', snap.source_session_id + '.jsonl');
  } catch {
    return null;
  }
}

export async function proactiveInject(
  prompt: string,
  candidates: Memory[],
  sessionEntry: SessionMapEntry | null,
): Promise<InjectResult | null> {
  if (candidates.length === 0) return null;

  const alreadySurfaced = new Set(sessionEntry?.surfacedMemories ?? []);
  const fresh = candidates.filter(m => !alreadySurfaced.has(m.id));
  if (fresh.length === 0) return null;

  // Embedding-first scoring; keyword fallback for memories without vectors.
  const embeddable = fresh.filter(m => m.embedding !== null);
  const noEmbedding = fresh.filter(m => m.embedding === null);

  let scored: Array<{ memory: Memory; score: number }> = [];

  if (embeddable.length > 0) {
    try {
      const ranked = await rankBySimilarity(prompt, embeddable, MAX_INJECT * 2);
      scored = ranked
        .filter(r => r.similarity >= EMBED_THRESHOLD)
        .map(r => ({ memory: r.memory, score: r.similarity }));
    } catch {
      // Ollama offline — fall back to keywords for all fresh candidates
      scored = fresh
        .map(m => ({ memory: m, score: keywordScore(prompt, m) }))
        .filter(({ score }) => score >= KEYWORD_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_INJECT);
    }
  }

  // Keyword-score memories that have no embedding
  const keywordScored = noEmbedding
    .map(m => ({ memory: m, score: keywordScore(prompt, m) }))
    .filter(({ score }) => score >= KEYWORD_THRESHOLD);

  // Merge and re-sort, capping at MAX_INJECT
  scored = [...scored, ...keywordScored]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_INJECT);

  if (scored.length === 0) return null;

  const lines: string[] = [
    '[Johnny] Relevant context not currently in your session:\n',
  ];
  let totalChars = lines[0].length;
  const injectedIds: string[] = [];

  for (const { memory, score } of scored) {
    const summary = (memory.summary ?? '').slice(0, 280) || '(no summary)';
    const pct = Math.round(score * 100);
    const readPath = await snapshotReadPath(memory.snapshotName);
    const loadLine = readPath
      ? `  → Read this file to load the full session: ${readPath}`
      : `  → Snapshot: ${memory.snapshotName} (use johnny_get_dump once available)`;

    const entry = [
      `▸ ${memory.snapshotName} (${pct}% relevant)`,
      `  ${summary}`,
      loadLine,
      '',
    ].join('\n');

    if (totalChars + entry.length > MAX_CHARS) break;
    lines.push(entry);
    totalChars += entry.length;
    injectedIds.push(memory.id);
  }

  if (injectedIds.length === 0) return null;

  lines.push(
    'If any of the above match what the user is asking about, Read the session file before answering.',
  );

  await log(`proactive-inject: offered ${injectedIds.length} memories (${injectedIds.map(id => scored.find(s => s.memory.id === id)?.memory.snapshotName).join(', ')})`);

  return { additionalContext: lines.join('\n'), injectedIds };
}
