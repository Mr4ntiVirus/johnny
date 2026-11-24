// Mosaic Recall chunker — turns a memory's transcript into ~300-token,
// boundary-respecting slices for chunk-level retrieval.
//
// Chunks are rerank inputs, not direct excerpts: the johnny_recall handler
// triages by cosine, then a small-LLM rerank pass picks/orders/paraphrases
// across the candidates to produce a curated digest. Target sizing therefore
// optimises for "coherent semantic unit small enough to fit ~30 of them
// through the rerank pass" (~300 tokens), not "ready-to-display excerpt".
//
// Design (v1):
//   - Pure, deterministic. Same input → same output.
//   - No overlap. Boundary-respecting: never split inside a fenced code block,
//     a stage-play speaker turn, or a paragraph if avoidable.
//   - Token estimate: chars / 4 (cheap, good enough for sizing).
//   - chunker_version stamped on every chunk so we can re-chunk old memories
//     under a future strategy without losing provenance.

import { embed, getEmbedModelName } from '../utils/llm.js';
import { createChunks, deleteChunksForMemory, existingChunkHashes } from '../store/db/chunks.js';
import { contentHash } from '../utils/content-hash.js';

export const CHUNKER_VERSION = 'v1';
const CHARS_PER_TOKEN = 4;

// mxbai-embed-large's real context window is 512 tokens (confirmed via
// `ollama ps`), but chunk sizing above estimates tokens as chars/4 — accurate
// for prose, but code/symbol-dense text tokenizes denser than that (down to
// ~2 chars/token), so a chunk within the chars/4 budget (maxTokens: 450) can
// still exceed 512 real tokens. Ollama hard-errors the whole request (500,
// "the input length exceeds the context length") rather than truncating, so
// an oversized chunk's embedding call fails every time it's retried — the
// daemon's embed-backfill would otherwise retry it forever.
//
// Rather than re-tightening maxTokens (perturbs chunk granularity/recall
// semantics for everything, and still just an estimate), truncate only the
// text handed to embed() — chunker.ts's own contract is that stored chunk
// text is the load-bearing artifact for FTS/rerank and the embedding is an
// accelerator, so truncating the embedding input while keeping the full text
// stored is within that contract. 800 chars stays safely under 512 tokens
// even at ~2 chars/token, with margin.
const EMBED_INPUT_MAX_CHARS = 800;
export function truncateForEmbedding(text: string): string {
  return text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;
}

/**
 * Shrink token-dense junk before embedding: long URLs collapse to host + first
 * path segment and opaque 40+ char tokens (tracking ids, base64, hashes) to a
 * marker. Such text tokenizes at ~1 char/token, blew Ollama's 512-token window
 * even inside the 800-char cap, and carries no semantic signal anyway. Stored
 * chunk text is never changed — only what is handed to embed().
 */
export function cleanForEmbedding(text: string): string {
  return text
    .replace(/https?:\/\/([^\s/)>\]]+)(\/[^\s/?#)>\]]*)?[^\s)>\]]*/g, (_m, host: string, p1?: string) => `${host}${p1 ?? ''}`)
    .replace(/[A-Za-z0-9_\-+=%]{40,}/g, '…');
}

const EMBED_FALLBACK_LENGTHS = [EMBED_INPUT_MAX_CHARS, 400, 200, 100];

/** Embed cleaned text, retrying shorter prefixes if Ollama rejects the input length. */
export async function embedChunkText(text: string): Promise<number[]> {
  const cleaned = cleanForEmbedding(text);
  let lastErr: unknown;
  for (const n of EMBED_FALLBACK_LENGTHS) {
    try { return await embed(cleaned.length > n ? cleaned.slice(0, n) : cleaned); }
    catch (err) { lastErr = err; if (cleaned.length <= n) break; }
  }
  throw lastErr;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
  // Absolute Date.now()-based deadline for chunkAndPersistMemory's embedding
  // loop. Once passed, remaining chunks are persisted with embedding=null
  // instead of blocking on more Ollama calls — the daemon's embed-backfill
  // picks them up later. Protects the caller's own wall-clock budget (e.g.
  // Claude Code's UserPromptSubmit hook timeout) against a large one-off
  // backlog. Unset = unbounded, matching prior behavior.
  deadline?: number;
}

export interface Chunk {
  index: number;
  text: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Split a transcript into chunks. Returns [] for empty/whitespace input.
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 300;
  const max = opts.maxTokens ?? 450;
  const min = opts.minTokens ?? 50;

  if (!text || !text.trim()) return [];

  const blocks = splitIntoBlocks(text);
  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const joined = current.join('\n').trim();
    if (joined) {
      chunks.push({ index: chunks.length, text: joined, tokenCount: estimateTokens(joined) });
    }
    current = [];
    currentTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block);

    if (blockTokens > max) {
      // Block alone exceeds the cap. Flush whatever's queued, then sub-split.
      flush();
      for (const sub of splitOversizedBlock(block, target, max)) {
        const tk = estimateTokens(sub);
        if (tk === 0) continue;
        chunks.push({ index: chunks.length, text: sub, tokenCount: tk });
      }
      continue;
    }

    if (currentTokens + blockTokens > target && currentTokens >= min) {
      flush();
    }

    current.push(block);
    currentTokens += blockTokens;
  }
  flush();

  return chunks;
}

/** Number of distinct chunks in `text` whose content is not already stored (any memory). */
export async function countNovelChunks(text: string, opts: ChunkOptions = {}): Promise<number> {
  const slices = chunkText(text, opts);
  if (slices.length === 0) return 0;
  const hashes = [...new Set(slices.map(s => contentHash(s.text)))];
  const existing = await existingChunkHashes(hashes);
  return hashes.filter(h => !existing.has(h)).length;
}

// Split text into "blocks" — coherent units we never want to break apart:
//   - fenced code blocks (```…```), kept intact even if very long (caller
//     will sub-split via splitOversizedBlock if needed)
//   - paragraphs separated by blank lines (covers stage-play turns and
//     markdown sections)
function splitIntoBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flushBuf = () => {
    if (buf.length === 0) return;
    const block = buf.join('\n').trim();
    if (block) blocks.push(block);
    buf = [];
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inFence) {
        buf.push(line);
        flushBuf();
        inFence = false;
      } else {
        flushBuf();
        buf.push(line);
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (line.trim() === '') {
      flushBuf();
    } else {
      buf.push(line);
    }
  }
  flushBuf();
  return blocks;
}

// Block exceeds maxTokens. Try splitting on sentence boundaries; if a single
// sentence is still oversized, hard-slice on character count as a last resort.
function splitOversizedBlock(block: string, target: number, max: number): string[] {
  const sentences = block.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push(current.join(' ').trim());
    current = [];
    currentTokens = 0;
  };

  for (const s of sentences) {
    const tk = estimateTokens(s);
    if (tk > max) {
      flush();
      const hardSlice = max * CHARS_PER_TOKEN;
      for (let i = 0; i < s.length; i += hardSlice) {
        const piece = s.slice(i, i + hardSlice).trim();
        if (piece) out.push(piece);
      }
      continue;
    }
    if (currentTokens + tk > target && current.length > 0) {
      flush();
    }
    current.push(s);
    currentTokens += tk;
  }
  flush();
  return out.filter(s => s.length > 0);
}

// Stable chunk id. Slug + '#' + index. Slug is the memory's snapshot_name,
// guaranteed unique across memories, so the composite is globally unique.
export function chunkIdFor(slug: string, index: number): string {
  return `${slug}#${index}`;
}

// Chunk a transcript, embed each chunk (best-effort — Ollama may be offline),
// and persist into the chunks table. Existing chunks for this memory are
// deleted first so re-running this function on the same memory is idempotent.
//
// Embedding failures are tolerated: chunks land with embedding=null and can
// be backfilled later. The text + chunk_id are the load-bearing parts; the
// embedding is an accelerator, not a correctness invariant.
export async function chunkAndPersistMemory(
  memoryId: string,
  slug: string,
  transcript: string,
  opts: ChunkOptions = {},
): Promise<{ count: number; embedded: number; skipped: number; duplicates: number }> {
  const allSlices = chunkText(transcript, opts);
  if (allSlices.length === 0) return { count: 0, embedded: 0, skipped: 0, duplicates: 0 };

  // Write-time dedup (primary guard against the recapture problem): a chunk
  // whose normalised text is already stored anywhere is not stored or embedded
  // again. Chunk indexes keep their original positions so chunk ids stay stable.
  const hashes = allSlices.map(s => contentHash(s.text));
  const already = await existingChunkHashes(hashes, memoryId);
  const seenHere = new Set<string>();
  const hashByIndex = new Map<number, string>();
  const slices = allSlices.filter((s, i) => {
    const h = hashes[i];
    if (already.has(h) || seenHere.has(h)) return false;
    seenHere.add(h);
    hashByIndex.set(s.index, h);
    return true;
  });
  const duplicates = allSlices.length - slices.length;
  if (slices.length === 0) {
    await deleteChunksForMemory(memoryId);
    return { count: 0, embedded: 0, skipped: 0, duplicates };
  }

  const modelName = getEmbedModelName();
  const deadline = opts.deadline;
  let embedded = 0;
  let skipped = 0;

  // Bounded concurrency. Ollama's /api/embeddings is single-input and CPU-bound
  // on the host's GPU/CPU; firing 60 concurrent requests for a chatty memory
  // wedges the server. 8 is enough to amortise per-request latency without
  // pushing the queue depth into timeout territory.
  const CONCURRENCY = 8;
  const inputs = new Array<{
    chunkId: string;
    memoryId: string;
    chunkIndex: number;
    text: string;
    tokenCount: number;
    embedding?: number[];
    embeddingModel?: string;
    chunkerVersion: string;
    contentHash: string;
  }>(slices.length);

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= slices.length) return;
      const s = slices[i];
      let vec: number[] | undefined;
      if (deadline !== undefined && Date.now() >= deadline) {
        skipped += 1;
      } else {
        try {
          vec = await embedChunkText(s.text);
          embedded += 1;
        } catch {
          skipped += 1;
        }
      }
      inputs[i] = {
        chunkId: chunkIdFor(slug, s.index),
        memoryId,
        chunkIndex: s.index,
        text: s.text,
        tokenCount: s.tokenCount,
        embedding: vec,
        embeddingModel: vec ? modelName : undefined,
        chunkerVersion: CHUNKER_VERSION,
        contentHash: hashByIndex.get(s.index)!,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, slices.length) }, () => worker()),
  );

  await deleteChunksForMemory(memoryId);
  await createChunks(inputs);

  return { count: inputs.length, embedded, skipped, duplicates };
}
