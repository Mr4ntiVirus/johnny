// Ambiguous-intent handler: instead of asking the user to disambiguate, pull
// the top-N candidate memories into the current session as a merged context.
// Claude gets digests of all of them via additionalContext (current turn) and
// full bodies appended to the JSONL (turns N+1 onward) — the same primitives
// recommend_memory uses, just fanned over a list.
//
// The fused state becomes a new Memory node so future retrievals can find the
// blend as a single entity (and the existing pressure-driven snapshot pipeline
// captures the actual JSONL state at the next checkpoint).
import {
  loadTrimmedMemoryBody,
  wrapBodyWithSyntheticFrame,
  appendMemoryEntriesIfTranscriptExists,
} from './recommend-memory.js';
import { addMemory } from '../store/memory.js';
import { embedMemory } from '../engine/embedder.js';
import { hasMemoryBeenSurfaced, recordMemorySurfaced } from '../store/session-map.js';
import { logHintEmission } from '../store/db/telemetry.js';
import type { MemoryNode, HookOutput } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';

const MAX_BLEND_CANDIDATES = 3;
const EXCERPTS_PER_MEMORY = 3;
const MAX_EXCERPT_CHARS = 400;

// Keep in sync with heuristics.ts — we want excerpt scoring to ignore the
// same junk words that keyword-matching ignores.
const STOPWORDS = new Set([
  'the','and','but','for','are','was','you','your','our','its','his','her',
  'has','had','have','will','can','could','should','would','may','might',
  'about','from','into','with','over','under','this','that','they','them',
  'these','those','who','whom','why','how','when','where','what','which',
  'not','all','any','some','one','two','new','old','own','yet','too','still',
  'also','just','like','than','then','now','only','very','more','most','much',
  'been','being','onto','upon','per','via','such','etc','ref','use',
  'user','claude','johnny','session',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[\s\W]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

// Pull readable text out of one JSONL entry, whatever shape it's in (string
// content, array of blocks, tool_result, etc). Returns null for entries with
// no human-readable text (raw tool_use blobs, attachments).
function extractTextFromEntry(entry: unknown): { role: string; text: string } | null {
  const l = entry as any;
  if (!l || typeof l !== 'object') return null;
  const role = l.type === 'assistant' ? 'assistant' : l.type === 'user' ? 'user' : null;
  if (!role) return null;

  const content = l.message?.content ?? l.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === 'string') text += ' ' + part.text;
      else if (typeof part?.content === 'string') text += ' ' + part.content;
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length < 20) return null; // skip ultra-short/empty
  return { role, text };
}

// Score each message in the body against the user's prompt tokens and pick the
// top-N. Each winning excerpt is truncated to MAX_EXCERPT_CHARS so three
// candidates together still fit in the current-turn context budget.
function extractRelevantExcerpts(bodyLines: unknown[], promptTokens: Set<string>): string[] {
  type Scored = { role: string; text: string; score: number };
  const scored: Scored[] = [];
  for (const entry of bodyLines) {
    const t = extractTextFromEntry(entry);
    if (!t) continue;
    const memTokens = tokenize(t.text);
    let hits = 0;
    for (const w of promptTokens) if (memTokens.has(w)) hits++;
    if (hits === 0) continue;
    scored.push({ ...t, score: hits });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, EXCERPTS_PER_MEMORY);
  return top.map(e => {
    const snippet = e.text.length > MAX_EXCERPT_CHARS
      ? e.text.slice(0, MAX_EXCERPT_CHARS) + '…'
      : e.text;
    return `[${e.role}] ${snippet}`;
  });
}

interface BlendPiece {
  mem: MemoryNode;
  excerpts: string[];
  bodyAppended: boolean;
}

function buildBlendDigest(prompt: string, pieces: BlendPiece[]): string {
  const lines: string[] = [
    `[johnny · suggest] ${pieces.length} possibly-relevant past contexts loaded. Use whichever parts are relevant to the user's prompt — blend them if more than one is useful.`,
  ];
  pieces.forEach((p, i) => {
    lines.push('');
    lines.push(`(${i + 1}) ${p.mem.snapshotName}`);
    lines.push(`    summary: ${p.mem.summary}`);
    if (p.mem.topics.length > 0) {
      lines.push(`    topics: ${p.mem.topics.slice(0, 8).join(', ')}`);
    }
    if (p.excerpts.length > 0) {
      lines.push(`    relevant excerpts:`);
      for (const ex of p.excerpts) lines.push(`      · ${ex}`);
    } else {
      lines.push(`    (no keyword-relevant excerpts found in prior session — summary above is all that's available)`);
    }
  });
  lines.push('');
  lines.push(`the user's current prompt: "${prompt.substring(0, 200)}"`);
  const anyAppended = pieces.some(p => p.bodyAppended);
  if (anyAppended) {
    lines.push(`full prior session bodies for the loaded contexts will be in scroll-back from the next turn onward.`);
  }
  return lines.join('\n');
}

function dateTag(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}${dd}`;
}

function buildBlendName(mems: MemoryNode[]): string {
  // Take first token of each snapshotName (before the date suffix) to keep it
  // short and readable. e.g. ['vault-code-reveal-0418', 'artimis-mission-0418']
  // → 'blend-vault-artimis-0418'.
  const shortTokens = mems
    .map(m => m.snapshotName.split('-')[0])
    .filter(t => t.length > 0)
    .slice(0, 3);
  return `blend-${shortTokens.join('-')}-${dateTag()}`;
}

function mergeTopics(mems: MemoryNode[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of mems) {
    for (const t of m.topics) {
      if (!seen.has(t) && t.length > 2) {
        seen.add(t);
        out.push(t);
      }
      if (out.length >= 20) return out;
    }
  }
  return out;
}

export async function suggestMemories(
  prompt: string,
  candidates: MemoryNode[],
  transcriptPath: string,
  sessionId: string,
  cwd: string,
  currentTurn: number,
): Promise<{ output: HookOutput; injectedIds: string[]; blendMemory: MemoryNode | null }> {
  const mems = candidates.slice(0, MAX_BLEND_CANDIDATES);
  if (mems.length === 0) {
    return { output: {}, injectedIds: [], blendMemory: null };
  }
  if (mems.length === 1) {
    // Defensive — caller should have used recommend_memory. Fall through to treat
    // as a degenerate single-memory blend so we still inject something useful.
  }

  // Stderr glyph: use ⇌⇌ to distinguish from single recommend_memory ⇌.
  const names = mems.map(m => m.snapshotName).join(', ');
  const line1 = neon.cyan('⇌⇌') + ink.fg(' blended context') + neon.cyan(` · ${mems.length} memories`);
  const line2 = dim.fg(`  ${names}`);
  const stderrLines = `${line1}\n${line2}`;

  // For each candidate: load body once, mine it for prompt-relevant excerpts
  // (for THIS turn's additionalContext), then append to JSONL (for turn N+1+).
  // Missing-snapshot errors fall back to digest-only for that one memory.
  const promptTokens = tokenize(prompt);
  const pieces: BlendPiece[] = [];
  const injected: string[] = [];

  for (const mem of mems) {
    const piece: BlendPiece = { mem, excerpts: [], bodyAppended: false };
    pieces.push(piece);

    let body: unknown[] = [];
    try {
      body = await loadTrimmedMemoryBody(mem);
      piece.excerpts = extractRelevantExcerpts(body, promptTokens);
    } catch (err) {
      await log(`suggest: ${mem.snapshotName} body load failed (${err}) — summary-only`);
      continue;
    }

    if (await hasMemoryBeenSurfaced(sessionId, mem.id)) {
      await log(`suggest: ${mem.snapshotName} already in transcript, skipping body append`);
      continue;
    }

    try {
      const entries = wrapBodyWithSyntheticFrame(mem, body, sessionId, cwd);
      const result = await appendMemoryEntriesIfTranscriptExists(transcriptPath, entries);
      if (result === 'appended') {
        await recordMemorySurfaced(sessionId, mem.id);
        injected.push(mem.id);
        piece.bodyAppended = true;
        await log(`suggest: ${mem.snapshotName} body appended (${entries.length} lines, ${piece.excerpts.length} excerpts)`);
      } else {
        await log(`suggest: ${mem.snapshotName} transcript not yet written — excerpts only`);
      }
    } catch (err) {
      await log(`suggest: ${mem.snapshotName} body-append failed (${err}) — excerpts only`);
    }
  }

  // Create a merged Memory node so this blend is addressable in future
  // retrievals. We don't create a new CMV snapshot here — the snapshot of the
  // current session's post-blend state gets captured by the pressure-driven
  // pipeline at its next checkpoint.
  let blendMemory: MemoryNode | null = null;
  try {
    const name = buildBlendName(mems);
    const summary = `Merged context from: ${mems.map(m => m.snapshotName).join(' + ')}.`;
    const title = `Merged memory from ${mems.length} sessions`;
    const mergedTranscript = mems.map(m => m.summary || '').join('\n\n---SESSION Boundary---\n\n');
    const tokenCount = mems.reduce((sum, m) => sum + (m.tokenCount ?? 0), 0);
    blendMemory = await addMemory(
      name,
      title,
      summary,
      mergedTranscript,
      cwd,
      tokenCount,
      mergeTopics(mems),
      currentTurn,
    );
    try { await embedMemory(blendMemory); } catch { /* Ollama offline — embedding deferred */ }
    await log(`suggest: created merged memory node ${name}`);
  } catch (err) {
    await log(`suggest: merged-memory-node creation failed (${err})`);
  }

  const additionalContext = buildBlendDigest(prompt, pieces);
  logHintEmission({
    sessionId,
    form: 'suggest_memories',
    suggestedMemoryIds: mems.map(m => m.id),
    tokenEstimate: Math.ceil(additionalContext.length / 4),
  });

  return {
    output: {
      additionalContext,
      systemMessage: stderrLines,
    },
    injectedIds: injected,
    blendMemory,
  };
}
