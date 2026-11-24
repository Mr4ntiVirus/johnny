// Johnny MCP Server — provides memory recall tools for Claude Code and other
// MCP clients. Connects via stdio. Tool handlers are exported as named
// functions so tests can drive them with seeded DBs without spinning up
// the stdio transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import * as memoriesDb from "../store/db/memories.js";
import * as transcriptsDb from "../store/db/transcripts.js";
import * as edgesDb from "../store/db/edges.js";
import * as searchDb from "../store/db/search.js";
import * as chunksDb from "../store/db/chunks.js";
import * as sessionsDb from "../store/db/sessions.js";
import { logRecallCall } from "../store/db/telemetry.js";
import { recordAction } from "../store/db/action-history.js";
import { getState, getTurnCounter } from "../store/db/state.js";
import { readConfig } from "../store/config.js";
import type { ContentType } from "../store/database.js";
import { slugify, extractTopics } from "../utils/slugify.js";
import { embed } from "../utils/llm.js";
import { getChunkIndex } from "../engine/chunk-index.js";
import { chunkAndPersistMemory } from "../engine/chunker.js";
import { searchKnowledge, type KnowledgeHit } from "../knowledge/retrieve.js";
import {
  handleModels, handleReflect, invalidateKnowledgeRef, isKnowledgeRef,
  knowledgeTileText, knowledgeTilesForRecall, type ModelsArgs, type ReflectArgs,
} from "./knowledge-tools.js";
import * as jobsDb from "../store/db/jobs.js";
import { cosine } from "../engine/embedder.js";
import { execute as localExecute } from "../store/local-db.js";

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  [k: string]: unknown;
}

// ── exported tool handlers (testable in isolation) ────────────────────────────

export interface RememberArgs {
  title: string;
  transcript: string;
  contentType?: 'text' | 'markdown' | 'code' | 'webpage' | 'image' | 'plan' | 'doc' | 'skill' | 'tool';
  language?: string;
  // Slug of an existing memory this one replaces. The old memory is kept (never
  // deleted) but marked superseded and dropped from recall; the facts extracted
  // from the new content then supersede the old beliefs automatically.
  supersedes?: string;
}

export async function handleRemember(args: RememberArgs): Promise<ToolResult> {
  const { title, transcript, contentType = 'text', language, supersedes } = args;
  try {
    let snapshotName = slugify(title);

    // Replacing an existing memory: explicit `supersedes`, or re-remembering a
    // title that already exists (the old behaviour was to refuse, which left no
    // way to correct a stale memory).
    const target = supersedes
      ? await memoriesDb.getMemoryBySnapshot(supersedes)
      : await memoriesDb.getMemoryBySnapshot(snapshotName);
    if (supersedes && !target) {
      return { content: [{ type: 'text', text: `No memory named "${supersedes}" to supersede. Check johnny_list.` }] };
    }
    if (target && target.snapshot_name === snapshotName) {
      snapshotName = `${snapshotName}-${new Date().toISOString().slice(0, 10)}`;
      if (await memoriesDb.getMemoryBySnapshot(snapshotName)) {
        return { content: [{ type: 'text', text: `Memory already exists: ${title}` }] };
      }
    }

    const topics = extractTopics(transcript);
    const tokenCount = Math.ceil(transcript.split(/\s+/).length * 1.3);

    const id = await memoriesDb.createMemory({
      snapshotName,
      title,
      summary: title,
      contentType: contentType as ContentType,
      projectPath: process.cwd(),
      tokenCount,
      createdAtTurn: 0,
    });
    await transcriptsDb.createTranscript({ memoryId: id, transcript, topics, contentFormat: language });

    // Chunk (best-effort, bounded) so the memory is reachable by chunk-first
    // recall and gets picked up by background fact extraction.
    try { await chunkAndPersistMemory(id, snapshotName, transcript, { deadline: Date.now() + 8000 }); } catch { /* backfill covers it */ }
    try { await jobsDb.setPending('extract', '', true); } catch { /* best-effort */ }

    let supersedeNote = '';
    if (target) {
      await memoriesDb.supersedeMemory(target.id, id);
      supersedeNote = `Superseded: ${target.snapshot_name} (kept as history, no longer recalled)`;
    }

    const text = [
      `Memory created: ${title}`,
      supersedeNote,
      `Name: ${snapshotName}`,
      `Topics: ${topics.slice(0, 5).join(', ')}`,
      `Tokens: ${tokenCount}`,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error creating memory: ${err}` }] };
  }
}

export interface SearchArgs {
  query: string;
  limit?: number;
}

interface SearchHit {
  name: string;
  topics: string[];
  snippet: string;
  score: number;     // 0..1 cosine, or normalized FTS rank
  mode: 'cosine' | 'fts';
}

// Trim summary to a single line bounded by ~100 chars.
function snippetFromSummary(summary: string | null | undefined): string {
  const s = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '(no summary)';
  if (s.length <= 100) return s;
  return s.slice(0, 97).trimEnd() + '…';
}

// Cosine search over every memory's stored embedding. Falls back to FTS when
// the query embed call fails (Ollama offline).
async function searchMemories(query: string, limit: number): Promise<SearchHit[]> {
  const memories = await memoriesDb.listMemories({ limit: 5000 });
  if (memories.length === 0) return [];

  let queryVec: number[] | null = null;
  try { queryVec = await embed(query); } catch { /* fall through to FTS */ }

  const topicsByMem = await transcriptsDb.getAllTopicsByMemory();

  if (queryVec) {
    const ids = memories.map(m => m.id);
    const embs = await transcriptsDb.getEmbeddingsByIds(ids);
    const scored: SearchHit[] = [];
    for (const m of memories) {
      const v = embs.get(m.id);
      if (!v) continue;
      scored.push({
        name: m.snapshot_name,
        topics: topicsByMem.get(m.id) ?? [],
        snippet: snippetFromSummary(m.summary),
        score: cosine(queryVec, v),
        mode: 'cosine',
      });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    }
    // No memories had embeddings — fall through to FTS so Claude isn't blocked.
  }

  const ftsRows = await searchDb.fullTextSearch({ query, limit });
  const memById = new Map(memories.map(m => [m.id, m] as const));
  return ftsRows.map((r, i) => ({
    name: r.snapshotName,
    topics: topicsByMem.get(r.memoryId) ?? [],
    snippet: snippetFromSummary(memById.get(r.memoryId)?.summary ?? r.summary),
    // FTS doesn't give a normalized similarity; degrade to a rank-based proxy
    // (1.0 down to 0.5 across the page) so the UI can still order them.
    score: ftsRows.length === 1 ? 1 : 1 - (0.5 * i) / Math.max(1, ftsRows.length - 1),
    mode: 'fts' as const,
  }));
}

// Format prose for Claude. Audience is a natural-language reader; never JSON.
function formatSearchProse(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return [
      `No memories matched "${query}".`,
      `Try johnny_list to browse the catalog, or rephrase.`,
    ].join('\n');
  }
  const fts = hits[0].mode === 'fts';
  const header = fts
    ? `${hits.length} matches for "${query}" (full-text — semantic search unavailable):`
    : `${hits.length} memories matched "${query}":`;
  const blocks = hits.map(h => {
    const pct = `${Math.round(h.score * 100)}%`;
    const topics = h.topics.length > 0 ? h.topics.slice(0, 5).join(', ') : '—';
    return [
      `${h.name}  ·  ${pct}`,
      `  Topics: ${topics}`,
      `  ${h.snippet}`,
    ].join('\n');
  });
  const footer = `Pull excerpts with johnny_recall({names: [...]}) or refine with johnny_recall({query: "..."}).`;
  return [header, '', ...blocks.join('\n\n').split('\n'), '', footer].join('\n');
}

export async function handleSearch(args: SearchArgs): Promise<ToolResult> {
  const { query, limit = 5 } = args;
  if (!query || !query.trim()) {
    return { content: [{ type: 'text', text: 'Search requires a non-empty query.' }] };
  }
  try {
    const hits = await searchMemories(query, limit);
    let knowledgeBlock = '';
    try {
      const qv = await embed(query);
      const kh = (await searchKnowledge(qv, { scope: null, limit: 6, minSimilarity: 0.45 })).slice(0, 4);
      if (kh.length > 0) {
        knowledgeBlock = [
          'Compiled knowledge (verified summaries built automatically from your history):',
          ...kh.map(h => `${h.ref}  ·  ${Math.round(h.similarity * 100)}%  ·  ${h.kind === 'model' ? h.title : h.kind}\n  ${snippetFromSummary(h.text)}`),
          'Read with johnny_models / johnny_reflect, or pull as tiles via johnny_recall.',
          '',
        ].join('\n');
      }
    } catch { /* knowledge is additive */ }
    return { content: [{ type: 'text', text: (knowledgeBlock ? knowledgeBlock + '\n' : '') + formatSearchProse(query, hits) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
}

// johnny_recall — chunk-level retrieval. Returns "tiles" (chunk excerpts)
// drawn from one or more memories, ranked by chunk-level cosine vs the query
// when present, or by chunk_index when only names are supplied. Stateless
// continuation: pass excludeChunkIds (or excludeNames) to ask for more tiles.
//
// Phase G.4 ships without rerank-LLM synthesis (Phase H). Tiles surface chunk
// text directly. The shape of the response is forward-compatible: when the
// rerank pass lands, it slots in between candidate retrieval and tile output.
export interface RecallArgs {
  query?: string;
  names?: string[];
  excludeNames?: string[];
  excludeChunkIds?: string[];
  tokenBudget?: number;
  perTileTokenCap?: number;
  limit?: number;
}

export interface Tile {
  chunkId: string;
  memoryId: string;
  memoryName: string;
  text: string;
  tokenCount: number;
  score: number;       // 0..1 cosine, or 0 in names-only mode
}

export interface MemoryHeader {
  id: string;
  name: string;
  topics: string[];
  rank: number;
  createdAt: string;
}

const RECALL_DEFAULT_TOKEN_BUDGET = 2000;
const RECALL_DEFAULT_PER_TILE_CAP = 300;
const RECALL_DEFAULT_LIMIT = 8;

// Estimate tokens for a chunk that didn't store its own count (legacy / fallback path).
function estimateTokenCountForChunk(text: string): number {
  return Math.ceil(text.length / 4);
}

// Trim a tile body to perTileTokenCap on a word boundary. Preserves shape when
// possible; degrades to a hard slice for sentences with no whitespace.
function trimTileText(text: string, perTileCap: number): { text: string; tokenCount: number } {
  const tokens = estimateTokenCountForChunk(text);
  if (tokens <= perTileCap) return { text, tokenCount: tokens };
  const targetChars = perTileCap * 4;
  const slice = text.slice(0, targetChars);
  const lastWs = slice.lastIndexOf(' ');
  const cut = lastWs > targetChars * 0.7 ? slice.slice(0, lastWs) : slice;
  const trimmed = cut.trimEnd() + '…';
  return { text: trimmed, tokenCount: estimateTokenCountForChunk(trimmed) };
}

// Build a candidate list of memory ids to draw chunks from.
// - names mode: resolve each snapshot_name → memory_id.
// - query+cosine mode: top N memories by summary-embedding cosine.
// - query+FTS mode (Ollama down): top N by FTS rank.
async function pickCandidateMemoryIds(
  args: { query?: string; names?: string[]; excludeNames?: string[]; breadth: number },
): Promise<{ ids: string[]; embedFailed: boolean }> {
  const excludeSet = new Set(args.excludeNames ?? []);

  if (args.names && args.names.length > 0) {
    const ids: string[] = [];
    for (const n of args.names) {
      if (excludeSet.has(n)) continue;
      const m = await memoriesDb.getMemoryBySnapshot(n);
      if (m) ids.push(m.id);
    }
    return { ids, embedFailed: false };
  }

  if (!args.query) return { ids: [], embedFailed: false };

  const all = await memoriesDb.listMemories({ limit: 5000 });
  if (all.length === 0) return { ids: [], embedFailed: false };

  let queryVec: number[] | null = null;
  try { queryVec = await embed(args.query); } catch { /* fall through to FTS */ }

  if (queryVec) {
    const ids = all.map(m => m.id);
    const embs = await transcriptsDb.getEmbeddingsByIds(ids);
    const scored = all
      .filter(m => !excludeSet.has(m.snapshot_name))
      .map(m => ({ id: m.id, score: embs.has(m.id) ? cosine(queryVec!, embs.get(m.id)!) : -Infinity }))
      .filter(s => s.score > -Infinity)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.breadth);
    if (scored.length > 0) return { ids: scored.map(s => s.id), embedFailed: false };
  }

  const fts = await searchDb.fullTextSearch({ query: args.query, limit: args.breadth });
  return {
    ids: fts.filter(r => !excludeSet.has(r.snapshotName)).map(r => r.memoryId),
    embedFailed: true,
  };
}

// Compiled knowledge (models > observations > facts) competes for the top of
// the answer with fixed tile ids (model:<slug> | obs:<id> | fact:<id>) so the
// existing paging (excludeChunkIds), token budget and telemetry work unchanged.
async function knowledgeCandidates(
  qv: number[], excludeChunkIds: Set<string>,
): Promise<{ tiles: Tile[]; headers: Map<string, MemoryHeader> }> {
  const tiles: Tile[] = [];
  const headers = new Map<string, MemoryHeader>();
  let hits: KnowledgeHit[] = [];
  try {
    hits = knowledgeTilesForRecall(await searchKnowledge(qv, { scope: null, limit: 14, minSimilarity: 0.45, withStaleness: true }));
  } catch { /* knowledge layer is additive: never fail recall because of it */ }
  for (const h of hits) {
    if (excludeChunkIds.has(h.ref)) continue;
    const body = knowledgeTileText(h);
    headers.set(h.ref, {
      id: h.ref, name: `compiled ${h.kind}: ${h.title}`, topics: [h.kind, h.scope === 'global' ? 'global' : 'project'],
      rank: 0, createdAt: h.asOf,
    });
    tiles.push({
      chunkId: h.ref, memoryId: h.ref, memoryName: `compiled ${h.kind}: ${h.title}`, text: body,
      tokenCount: estimateTokenCountForChunk(body), score: h.similarity,
    });
  }
  return { tiles, headers };
}

const isKnowledgeId = (id: string): boolean => /^(model|obs|fact):/.test(id);

export interface RecallSelection {
  selected: Tile[];
  headers: Map<string, MemoryHeader>;
  totalTokens: number;
  morePossible: number;
  candidateCount: number;
}

// Pure retrieval + selection: no side effects, no formatting. Shared by
// handleRecall (which adds telemetry/reinforcement + prose) and the read-only
// eval harness (`johnny eval-recall`).
export async function selectRecall(
  args: RecallArgs,
): Promise<{ empty: string } | RecallSelection> {
  const {
    query,
    names,
    excludeNames,
    excludeChunkIds = [],
    tokenBudget = RECALL_DEFAULT_TOKEN_BUDGET,
    perTileTokenCap = RECALL_DEFAULT_PER_TILE_CAP,
    limit = RECALL_DEFAULT_LIMIT,
  } = args;

  // ── Chunk-first path (query mode) ──────────────────────────────────────────
  // Score every stored chunk vector directly instead of preselecting 8 memories
  // by summary similarity (clone summaries used to fill every slot). Falls
  // through to the legacy memory-first path for names mode, when the embedder
  // is down, or when the store is too large/empty to index.
  if (!(names && names.length > 0) && query && query.trim()) {
    let qv: number[] | null = null;
    try { qv = await embed(query); } catch { qv = null; }
    const idx = qv ? await getChunkIndex() : null;
    if (qv && idx) {
      const excludeNameSet = new Set(excludeNames ?? []);
      let lexicalChunkIds: Set<string> | undefined;
      try { lexicalChunkIds = await chunksDb.lexicalChunkIds(query); } catch { /* dense-only is fine */ }
      const hits = idx.search(qv, Math.max(limit * 6, 40), {
        excludeChunkIds: new Set(excludeChunkIds), maxPerMemory: 3, lexicalChunkIds,
      }).filter(h => !excludeNameSet.has(idx.memories.get(h.memoryId)?.name ?? ''));
      if (hits.length > 0) {
        const texts = await chunksDb.getChunkTexts(hits.map(h => h.chunkId));
        const topicsByMem = await transcriptsDb.getAllTopicsByMemory();
        const headers = new Map<string, MemoryHeader>();
        const candidates: Tile[] = [];
        for (const h of hits) {
          const text = texts.get(h.chunkId);
          const meta = idx.memories.get(h.memoryId);
          if (!text || !meta) continue;
          if (!headers.has(h.memoryId)) {
            headers.set(h.memoryId, {
              id: h.memoryId, name: meta.name, topics: topicsByMem.get(h.memoryId) ?? [],
              rank: meta.rank, createdAt: meta.createdAt,
            });
          }
          candidates.push({
            chunkId: h.chunkId, memoryId: h.memoryId, memoryName: meta.name, text,
            tokenCount: h.tokenCount > 0 ? h.tokenCount : estimateTokenCountForChunk(text),
            score: h.cosine,
          });
        }
        if (candidates.length > 0) {
          const k = await knowledgeCandidates(qv, new Set(excludeChunkIds));
          for (const [id, h] of k.headers) headers.set(id, h);
          // Compiled tiles lead, but raw chunks keep a floor of 3 slots: an exact-term chunk (found by the
          // lexical lane) must stay reachable instead of being crowded out by up to 7 compiled tiles.
          const rawFloor = Math.min(3, candidates.length);
          const compiled = k.tiles.slice(0, Math.max(0, limit - rawFloor));
          return fillSelection([...compiled, ...candidates], headers, { limit, tokenBudget, perTileTokenCap });
        }
      }
    }
  }

  const { ids: candidateIds } = await pickCandidateMemoryIds({
    query, names, excludeNames,
    breadth: Math.max(8, limit),
  });

  if (candidateIds.length === 0) {
    // No raw memory matched — compiled knowledge can still answer a query.
    if (!(names && names.length > 0) && query && query.trim()) {
      let qv: number[] | null = null;
      try { qv = await embed(query); } catch { qv = null; }
      if (qv) {
        const k = await knowledgeCandidates(qv, new Set(excludeChunkIds));
        if (k.tiles.length > 0) return fillSelection(k.tiles, k.headers, { limit, tokenBudget, perTileTokenCap });
      }
    }
    const what = names?.length ? 'No memories matched the names you passed.' : `No memories matched "${query ?? ''}".`;
    return { empty: `${what}\nTry johnny_search to discover what's available.` };
  }

  // Embed query for chunk-level scoring (best-effort; in names-only mode it's
  // optional — chunks are surfaced in chunk_index order with score=0).
  let queryVec: number[] | null = null;
  if (query && query.trim()) {
    try { queryVec = await embed(query); } catch { /* fall through */ }
  }

  // Gather candidate tiles from each memory's chunks. Memories without chunks
  // (legacy / pre-Phase-G.2) get a single-tile fallback from the transcript so
  // they remain reachable.
  const excludeChunkSet = new Set(excludeChunkIds);
  const headers = new Map<string, MemoryHeader>();
  const candidates: Tile[] = [];

  const topicsByMem = await transcriptsDb.getAllTopicsByMemory();

  for (const memId of candidateIds) {
    const mem = await memoriesDb.getMemory(memId);
    if (!mem) continue;
    headers.set(memId, {
      id: memId,
      name: mem.snapshot_name,
      topics: topicsByMem.get(memId) ?? [],
      rank: mem.rank,
      createdAt: mem.created_at,
    });

    const chunks = await chunksDb.getChunksForMemory(memId);
    if (chunks.length === 0) {
      const transcript = await transcriptsDb.getTranscriptText(memId);
      if (!transcript) continue;
      const synthetic: Tile = {
        chunkId: `${mem.snapshot_name}#legacy`,
        memoryId: memId,
        memoryName: mem.snapshot_name,
        text: transcript,
        tokenCount: estimateTokenCountForChunk(transcript),
        score: queryVec ? 0.5 : 0,
      };
      if (!excludeChunkSet.has(synthetic.chunkId)) candidates.push(synthetic);
      continue;
    }

    for (const c of chunks) {
      if (excludeChunkSet.has(c.chunk_id)) continue;
      let score = 0;
      if (queryVec) {
        const v = chunksDb.decodeChunkEmbedding(c.embedding);
        score = v ? cosine(queryVec, v) : 0;
      }
      candidates.push({
        chunkId: c.chunk_id,
        memoryId: memId,
        memoryName: mem.snapshot_name,
        text: c.text,
        tokenCount: c.token_count > 0 ? c.token_count : estimateTokenCountForChunk(c.text),
        score,
      });
    }
  }

  if (candidates.length === 0) {
    return { empty: `Found ${candidateIds.length} matching memories but no tiles to show (all chunks excluded).` };
  }

  // Rank: chunk-level cosine when query was embedded; otherwise (names-only,
  // or query-but-Ollama-down) fall back to chunk_index order grouped by memory.
  if (queryVec) {
    candidates.sort((a, b) => b.score - a.score);
  }

  let ordered = candidates;
  if (queryVec) {
    const k = await knowledgeCandidates(queryVec, excludeChunkSet);
    for (const [id, h] of k.headers) headers.set(id, h);
    ordered = [...k.tiles, ...candidates];
  }
  const sel = fillSelection(ordered, headers, { limit, tokenBudget, perTileTokenCap });
  if ('empty' in sel) return sel;
  return { ...sel, candidateCount: candidateIds.length };
}

// Greedy fill respecting the per-tile cap, tile limit and total token budget.
function fillSelection(
  candidates: Tile[],
  headers: Map<string, MemoryHeader>,
  o: { limit: number; tokenBudget: number; perTileTokenCap: number },
): RecallSelection {
  const selected: Tile[] = [];
  let totalTokens = 0;
  for (const tile of candidates) {
    if (selected.length >= o.limit) break;
    const trimmed = trimTileText(tile.text, o.perTileTokenCap);
    if (totalTokens + trimmed.tokenCount > o.tokenBudget && selected.length > 0) break;
    selected.push({ ...tile, text: trimmed.text, tokenCount: trimmed.tokenCount });
    totalTokens += trimmed.tokenCount;
  }
  return {
    selected, headers, totalTokens,
    morePossible: Math.max(0, candidates.length - selected.length),
    candidateCount: headers.size,
  };
}

export async function handleRecall(args: RecallArgs): Promise<ToolResult> {
  const { query, names, excludeChunkIds = [] } = args;

  if ((!query || !query.trim()) && (!names || names.length === 0)) {
    return {
      content: [{ type: 'text', text: 'Recall requires a query or a names list. Pass {query: "..."} or {names: ["slug-a", "slug-b"]}.' }],
    };
  }

  try {
    const sel = await selectRecall(args);
    if ('empty' in sel) return { content: [{ type: 'text', text: sel.empty }] };
    const { selected, headers, totalTokens, morePossible } = sel;

    // Side effects: record retrieval per memory + log to active session for
    // provenance-edge wiring (Phase G.8 reads sessions.recalled_memory_ids).
    const contributingIds = Array.from(new Set(selected.filter(t => !isKnowledgeId(t.chunkId)).map(t => t.memoryId)));
    const usedChunkIdsForTelemetry = selected.map(t => t.chunkId);
    try {
      const [activeSessionId, currentTurn] = await Promise.all([
        getState('active_session'),
        getTurnCounter(),
      ]);
      for (const id of contributingIds) {
        await memoriesDb.recordRetrieval(id, currentTurn);
        if (activeSessionId) await sessionsDb.addRecalledMemoryId(activeSessionId, id);
        if (activeSessionId) await sessionsDb.addSurfacedMemory(activeSessionId, id);
      }
      // Doctor's "recalled Xh/Yd/Zw" figures are action_history-derived
      // (RECALL_ACTIONS in store/stats.ts) — without this row, MCP-driven
      // recalls bumped retrieval_count (visible in "ever N/total") but never
      // showed up in the rolling hour/day/week counts, since only evaluate.ts's
      // hook-decision actions used to write to action_history. One row per
      // johnny_recall call (not per contributing memory), matching the
      // existing "one row per decision" granularity.
      if (contributingIds.length > 0) {
        await recordAction({
          sessionId: activeSessionId ?? 'unknown',
          turn: currentTurn,
          recallScore: null,
          cmvPressure: null,
          limitPressure: null,
          action: 'mcp_recall',
          matchedMemoryId: contributingIds[0],
          durationMs: null,
        });
      }
      await logRecallCall({
        sessionId: activeSessionId ?? 'unknown',
        query,
        requestedNames: names,
        excludedChunkIds: excludeChunkIds,
        chunksReturned: usedChunkIdsForTelemetry.length,
        memoryIds: contributingIds,
      });

      // Hebbian co-reinforcement: memories recalled together signal association.
      // Lower delta than hook-triggered surfaces — recalls include exploratory
      // pulls, not just confirmed relevance. Cap prevents O(n²) edge storms.
      const config = await readConfig();
      const coIds = contributingIds.slice(0, config.mcpRecallMaxCoReinforce);
      if (coIds.length > 1) {
        const delta = config.mcpRecallReinforcementDelta;
        for (let i = 0; i < coIds.length; i++) {
          for (let j = i + 1; j < coIds.length; j++) {
            await edgesDb.reinforceEdge(coIds[i], coIds[j], delta, currentTurn);
            await edgesDb.reinforceEdge(coIds[j], coIds[i], delta, currentTurn);
          }
        }
      }
    } catch { /* telemetry + reinforcement are best-effort; never fail the recall */ }

    // Format prose. Audience is Claude — prose, never JSON. Group tiles under
    // their memory header so per-memory metadata isn't repeated for each tile.
    const tilesByMem = new Map<string, Tile[]>();
    for (const t of selected) {
      const arr = tilesByMem.get(t.memoryId) ?? [];
      arr.push(t);
      tilesByMem.set(t.memoryId, arr);
    }

    const blocks: string[] = [];
    for (const [memId, tiles] of tilesByMem) {
      const h = headers.get(memId);
      if (!h) continue;
      const topics = h.topics.length > 0 ? h.topics.slice(0, 5).join(', ') : '—';
      const headerLines = isKnowledgeId(memId)
        ? [h.name, `  Compiled: ${h.createdAt.slice(0, 10)}`]
        : [h.name, `  Topics: ${topics}`, `  Created: ${h.createdAt.slice(0, 10)}`];
      const tileLines: string[] = [];
      tiles.forEach((t, i) => {
        const pct = `${Math.round(t.score * 100)}%`;
        tileLines.push('');
        tileLines.push(`  Tile ${i + 1}/${tiles.length}  ·  ${pct}  ·  ${t.chunkId}`);
        tileLines.push(t.text.split('\n').map(l => `    ${l}`).join('\n'));
      });
      blocks.push([...headerLines, ...tileLines].join('\n'));
    }

    const header = [
      `${selected.length} tile${selected.length === 1 ? '' : 's'} from ${tilesByMem.size} memor${tilesByMem.size === 1 ? 'y' : 'ies'}`,
      `(≈${totalTokens} tokens). ${morePossible} more available.`,
    ].join(' ');

    const usedChunkIds = selected.map(t => t.chunkId);
    const footer = morePossible > 0
      ? `To pull more, call johnny_recall again with excludeChunkIds: [${usedChunkIds.map(id => `"${id}"`).join(', ')}].`
      : `That's everything matching this query. Try a different query or johnny_search to broaden.`;

    const text = [header, '', ...blocks, '', footer].join('\n\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
}

export interface ListArgs {
  limit?: number;
}

export async function handleList(args: ListArgs): Promise<ToolResult> {
  const { limit = 10 } = args;
  try {
    const mems = await memoriesDb.listMemories({ limit, orderBy: 'rank' });
    if (mems.length === 0) {
      return { content: [{ type: 'text', text: 'No memories found' }] };
    }
    const text = mems.map((m, i) => {
      return `${i + 1}. ${m.snapshot_name} (rank: ${m.rank.toFixed(3)}, tokens: ${m.token_count})`;
    }).join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
}

export async function handleGraph(): Promise<ToolResult> {
  try {
    const [totalMemories, edgeStats, topMemories] = await Promise.all([
      memoriesDb.getMemoryCount(),
      edgesDb.getEdgeStats(),
      memoriesDb.getTopMemoriesByRank(5),
    ]);
    const topNames = topMemories.map(m => m.snapshot_name).join(', ');
    const text = [
      `Graph Statistics`,
      `Total Memories: ${totalMemories}`,
      `Total Edges: ${edgeStats.totalEdges}`,
      `Average Edge Weight: ${edgeStats.avgWeight.toFixed(3)}`,
      ``,
      `Top Memories: ${topNames || 'none'}`,
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
}

export interface InvalidateArgs {
  name: string;
  reason?: string;
}

export async function handleInvalidate(args: InvalidateArgs): Promise<ToolResult> {
  const { name, reason } = args;
  if (isKnowledgeRef(name)) return invalidateKnowledgeRef(name, reason);
  try {
    const mem = await memoriesDb.getMemoryBySnapshot(name);
    if (!mem) {
      return { content: [{ type: 'text', text: `No memory named "${name}". Check johnny_list for available names.` }] };
    }
    const [turn, { incoming, outgoing }] = await Promise.all([
      getTurnCounter(),
      edgesDb.getAllEdgesFor(mem.id),
    ]);
    let count = 0;
    for (const e of [...outgoing, ...incoming]) {
      await edgesDb.invalidateEdge(e.source_id, e.target_id, turn);
      count++;
    }
    const msg = `Marked ${count} edge${count === 1 ? '' : 's'} of "${name}" as invalidated.${reason ? ` Reason: ${reason}` : ''}`;
    return { content: [{ type: 'text', text: msg }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}` }] };
  }
}

// ── server registration ───────────────────────────────────────────────────────

const server = new McpServer({ name: 'johnny', version: '1.0.0' });

server.registerTool(
  'johnny_remember',
  {
    description: "Save something to the user's persistent memory. Use when the user explicitly says 'remember', 'save', 'note', 'keep this' — or when they've just made a decision or discovery they'll want to find again later. The memory becomes searchable across all future sessions.",
    inputSchema: {
      title: z.string().describe('Title or name for this memory'),
      transcript: z.string().describe('The body/content of the memory to store'),
      contentType: z.enum(['text', 'markdown', 'code', 'webpage', 'image', 'plan', 'doc', 'skill', 'tool']).optional().default('text'),
      language: z.string().optional(),
    },
  },
  async (args) => handleRemember(args as RememberArgs),
);

server.registerTool(
  'johnny_search',
  {
    description: "Discovery probe over the user's persistent memory. Cheap — returns just memory names, topics, and a one-line snippet, no bodies. Use when you suspect the user has prior work on a topic but you're not sure what's there: scan the catalog first, then call johnny_recall to pull the excerpts that look relevant. Also good when the user asks 'what do you remember about X' or 'have we worked on Y before'.",
    inputSchema: {
      query: z.string().describe('Search query'),
      limit: z.number().optional().default(5),
    },
  },
  async (args) => handleSearch(args as SearchArgs),
);

server.registerTool(
  'johnny_recall',
  {
    description: "The user's persistent memory of their own work, decisions, and discoveries. Prefer this over your training when the user's question implies prior context they've built — they keep specific, hard-won knowledge here that will be more accurate and relevant than general advice. Trigger situations: continuing work from a prior session ('pick up where we left off', 'the X we were working on'), referencing past decisions ('what did we decide about Y', 'why did we choose Z'), mentioning code/designs/incidents you don't have context on, or any question whose right answer depends on what THIS user has done before. Returns excerpt tiles, not whole bodies — pass excludeChunkIds to keep paging through the same query.",
    inputSchema: {
      query: z.string().optional().describe('Search query'),
      names: z.array(z.string()).optional().describe('Memory snapshot names to pull excerpts from'),
      excludeNames: z.array(z.string()).optional().describe('Memory names to exclude (already seen)'),
      excludeChunkIds: z.array(z.string()).optional().describe('Specific chunk ids to exclude (for stateless continuation)'),
      tokenBudget: z.number().optional().default(2000).describe('Max total tokens across all returned tiles'),
      perTileTokenCap: z.number().optional().default(300).describe('Max tokens per tile (longer chunks get truncated)'),
      limit: z.number().optional().default(8).describe('Max number of tiles returned'),
    },
  },
  async (args) => handleRecall(args as RecallArgs),
);

server.registerTool(
  'johnny_list',
  {
    description: "Browse the catalog of saved memories — titles, topics, recency, rank. Use when the user asks what's in memory, or when you want a wide-angle view of their work before choosing where to dig. Cheaper than search; doesn't require a query.",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  async (args) => handleList(args as ListArgs),
);

server.registerTool(
  'johnny_graph',
  {
    description: "Quick stats on the memory graph — count of memories, edges, top-ranked nodes. Use to gauge how much prior context exists before deciding whether to call johnny_search or johnny_recall.",
    inputSchema: {},
  },
  async () => handleGraph(),
);

server.registerTool(
  'johnny_models',
  {
    description: "Read Johnny's compiled mental models: standing, verified overviews of a subject (a system, project, or set of conventions) that Johnny builds and refreshes automatically in the background from your history. Call with no arguments to list them; pass a name to read one in full. Relevant models are also recalled for you automatically — use this when you want the full document or to check what Johnny knows. Set refresh:true to request a rebuild on the next background run.",
    inputSchema: {
      name: z.string().optional().describe('Model slug to read in full; omit to list all models'),
      refresh: z.boolean().optional().describe('Queue this model for a rebuild on the next background run'),
    },
  },
  async (args) => handleModels(args as ModelsArgs),
);

server.registerTool(
  'johnny_reflect',
  {
    description: "Introspect memory on a question: returns the compiled mental models that answer it, the consolidated observations behind them (with how many sessions back each), the extracted facts with evidence quotes, and finally raw conversation excerpts — in that order, each marked stale/disputed when applicable. Use it when you need to understand WHAT Johnny knows and WHY, check whether something recalled is still true, or find the original evidence. Deterministic retrieval (no model call): you do the reasoning. If something is wrong or outdated, flag it with johnny_invalidate using the ref shown (model:…, obs:…, fact:…).",
    inputSchema: {
      question: z.string().describe('The question or topic to reflect on'),
      depth: z.enum(['summary', 'evidence']).optional().default('evidence').describe("'summary' omits per-observation evidence"),
    },
  },
  async (args) => handleReflect(args as ReflectArgs, {
    rawTiles: async (question) => {
      const sel = await selectRecall({ query: question, limit: 6 });
      if ('empty' in sel) return [];
      return sel.selected.filter(t => !isKnowledgeId(t.chunkId)).map(t => ({
        memoryName: t.memoryName, chunkId: t.chunkId, text: t.text, score: t.score,
      }));
    },
  }),
);

server.registerTool(
  'johnny_invalidate',
  {
    description: "Flag a memory — or a compiled fact, observation or model — as stale: use when you've recalled it and found it contradicts what the user just told you, or the decision it documents is no longer current. For a memory (slug) this penalizes (but never deletes) its Hebbian edges so it surfaces less. For a ref shown by johnny_reflect/recall (fact:<id>, obs:<id>, model:<slug>) the item is flagged and everything built on it is reconsidered and rebuilt automatically on the next background run. To REPLACE stale content with corrected content, prefer johnny_remember with supersedes.",
    inputSchema: {
      name: z.string().describe('Snapshot name (slug) of a memory, or a ref: fact:<id> | obs:<id> | model:<slug>'),
      reason: z.string().optional().describe('Brief description of why the memory appears stale'),
    },
  },
  async (args) => handleInvalidate(args as InvalidateArgs),
);

// ── entry point ───────────────────────────────────────────────────────────────

// Exported so the CLI can call it explicitly via `johnny mcp`. Tests import
// the handlers above without calling this — which keeps the stdio transport
// from blocking on stdin in a test process.
export async function runMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Johnny MCP Server running on stdio');
}

// Auto-run only when this module is the script entry point (e.g. invoked
// directly with `node dist/mcp/index.js`). The CLI imports + calls
// runMcpServer() explicitly.
const isEntryPoint = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runMcpServer().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
