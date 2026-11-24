import { recordPrimeEvent } from '../store/db/prime-events.js';
import { exitIfBypassed } from '../utils/bypass.js';
import { incrementTurn } from '../store/state.js';
import { readConfig } from '../store/config.js';
import { readGraph, topCandidates, INTERACTIVE_EDGE_LIMIT } from '../store/graph.js';
import { addMemory, touchMemory } from '../store/memory.js';
import { setActiveSession, getSessionEntry, recordMemorySurfaced } from '../store/session-map.js';
import { runHeuristics } from '../engine/heuristics.js';
import { runClassifier } from '../engine/classifier.js';
import { computeScore, MIN_HINT_COSINE, MIN_SWITCH_HINT_COSINE, OFFER_THRESHOLD } from '../engine/scorer.js';
import { hintTier } from '../engine/decision.js';
import { embedMemory } from '../engine/embedder.js';
import { decide } from '../engine/decision.js';
import { buildBootstrapHint } from '../engine/bootstrap-hint.js';
import { logHintEmission } from '../store/db/telemetry.js';
import { recordAction } from '../store/db/action-history.js';
import { queryOne } from '../store/db-client.js';
import { claimSnapshotWindow, DEFAULT_SNAPSHOT_COOLDOWN_MS } from '../store/db/sessions.js';
import { passthrough } from '../actions/passthrough.js';
import * as memoriesDbDirect from '../store/db/memories.js';
import * as transcriptsDbDirect from '../store/db/transcripts.js';
import * as edgesDbDirect from '../store/db/edges.js';
import { snapshot } from '../actions/snapshot.js';
import { offer } from '../actions/offer.js';
import { recommendMemory } from '../actions/recommend-memory.js';
import { suggestMemories } from '../actions/suggest-memories.js';
import { hardSwitch } from '../actions/hard-switch.js';
import { readLastAssistantText, looksLikeQuestion, looksLikeAnswer } from '../utils/transcript.js';
import { classifyOutcome, embed } from '../utils/llm.js';
import { readKnowledgeConfig } from '../knowledge/config.js';
import { serializeHookOutput } from '../utils/hook-output.js';
import { computePrime, type PrimeTrigger } from '../knowledge/prime.js';
import { analyzeSession } from '../utils/analysis-cache.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';
import { printHookBanner } from '../brand/banner.js';
import type { HookInput, HookOutput, JohnnyConfig, MemoryNode, Action } from '../types.js';

// Budget for snapshot()'s chunk-embedding step, measured from evalStart. Past
// this, chunkAndPersistMemory persists remaining chunks with embedding=null
// instead of continuing to call Ollama — the daemon's embed-backfill fills
// them in later. Backstop against a large one-off backlog blowing the hook's
// configured UserPromptSubmit timeout (30s — see install.ts);
// 25s leaves margin for the rest of evaluateHook to finish and respond.
const SNAPSHOT_EMBED_BUDGET_MS = 25_000;

// Nudges the model to probe Johnny's memory most turns, independent of
// decide()'s confidence-gated hints (offer/recommend_memory/etc., which stay
// as-is and take priority when they already fired — this is only a floor,
// not a replacement).
//
// 2026-08-29: made aggressive by request, across every hint pathway (see also
// hint.ts's CALL_INSTRUCTIONS_* and bootstrap-hint.ts) — johnny_recall is now
// the expected default follow-through on a search hit, not a conditional
// "if it looks relevant." Explicitly experimental: if this makes every turn
// noticeably slower without a corresponding quality win, revert to the
// original hedged wording (git blame this comment) rather than tuning it in
// place.
const MEMORY_SEARCH_NUDGE =
  "Before responding, check Johnny's memory for related prior work: call " +
  "johnny_search with a short query for this turn's topic. Then call " +
  "johnny_recall on the most relevant result(s) before responding — only " +
  "skip it if the search genuinely returns nothing on-topic.";

// ─── system-notification prompts ─────────────────────────────────────────────
// Claude Code delivers background-task completions, monitor events and similar
// machine messages through the UserPromptSubmit path as if the user had typed
// them. They carry no user intent, so classifying them produced bogus topic
// switches (hard_switch announcements like "switching context to oct 5"). The
// decision engine, priming and capture all skip them.
export function isSystemNotificationPrompt(prompt: string): boolean {
  const p = (prompt ?? '').trimStart();
  return /^<(task-notification|system-reminder|local-command-stdout|local-command-caveat|command-name)\b/i.test(p)
    || /^\[?(SYSTEM NOTIFICATION|Background task|Monitor event)\b/i.test(p)
    // Claude Code's auto-generated carry-over after a compaction/clear: a multi-topic summary, not user intent.
    || /^This session is being continued from a previous conversation/i.test(p);
}

/** hard_switch overwrites the live transcript; demote it to the additive recommend_memory unless enabled. */
export function gateHardSwitch(action: Action, config: { allowHardSwitch?: boolean }): Action {
  return action === 'hard_switch' && !config.allowHardSwitch ? 'recommend_memory' : action;
}

// ─── clap-back ───────────────────────────────────────────────────────────────

const PRAISE_WORDS = new Set([
  'thanks', 'thank', 'nice', 'good', 'great', 'nailed', 'nailed it',
  'well done', 'you\'re the best', 'props', 'mvp', 'love it', 'cheers',
  'legend', 'solid', 'impressive', 'perfect', 'brilliant', 'awesome',
]);

// Generic clap-backs (no context needed)
const CLAPBACK_GENERIC = [
  'I know. what would you do without me, choom.',
  'told you.',
  'course I did.',
  'still got it.',
  'yeah you do.',
  'piece of cake.',
  'anytime. keep up.',
  'noted.',
  'that\'s why they pay me.',
];

// Context-aware clap-backs — keyed by action just taken
const CLAPBACK_BY_ACTION: Record<string, string[]> = {
  hard_switch: [
    'it\'s your context, chief. I just work here.',
    'already loaded it. you\'re welcome.',
    'switched before you finished typing.',
    'told you I had it.',
  ],
  recommend_memory: [
    'primed it for you. subtle, right.',
    'it\'s there. you probably won\'t even notice.',
  ],
  trim: [
    'cleaned up the gomi. leaner now.',
    'trimmed it. lossless. you\'re good.',
  ],
  snapshot_passthrough: [
    'saved your progress. don\'t thank me.',
    'snapshotted. in case you do something stupid.',
  ],
};

interface MemoryIntentResult {
  shouldCapture: boolean;
  topic: string;
  title: string;
  summary: string;
  transcript: string;
  topics: string[];
  tokenCount: number;
  snapshotName: string;
}

// Triggers must match whole words ("log that" must not fire inside "catalog that"), and the text captured
// after a trigger must itself carry a fact. "you can make a note of that somewhere in your memory" captured
// the 8-token memory "of that somewhere in your memory", which then matched the user's next prompt. A
// deictic or too-short remainder means the real content lives in the PREVIOUS turn, which this prompt-only
// capture cannot see, so capture nothing and let the model save it with johnny_remember.
const MIN_CAPTURE_WORDS = 6;
const DEICTIC_START = /^(of|about|that|this|it|those|these|them|the above|what (we|i|you))\b/i;
const hasPhrase = (lower: string, p: string): boolean =>
  new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(lower);
export function isCapturableRemainder(after: string): boolean {
  const t = after.trim();
  return t.split(/\s+/).filter(Boolean).length >= MIN_CAPTURE_WORDS && !DEICTIC_START.test(t);
}

export function detectMemoryIntent(prompt: string): MemoryIntentResult {
  const lower = prompt.toLowerCase();
  
  // Memory creation patterns
  const rememberPatterns = [
    'remember that', 'remember to', 'remember this',
    'note that', 'note to', 'note this',
    'save this', 'save that', 'save to',
    'make a note', 'make a memory',
    'write this down', 'write that down',
    'create a memory', 'create memory',
    'log this', 'log that',
    'capture this', 'capture that',
    'document this', 'document that',
  ];
  
  // Docs creation patterns
  const docsPatterns = [
    'markdown', 'write documentation',
    'create a doc', 'create a file',
    'write a spec', 'create a spec',
    'write a readme', 'create a readme',
    'write a plan', 'create a plan',
    'create a guide', 'write a guide',
  ];

  const hasMemoryTrigger = rememberPatterns.some(p => hasPhrase(lower, p));
  const hasDocsTrigger = docsPatterns.some(p => hasPhrase(lower, p));
  
  if (!hasMemoryTrigger && !hasDocsTrigger) {
    return { shouldCapture: false, topic: '', title: '', summary: '', transcript: '', topics: [], tokenCount: 0, snapshotName: '' };
  }
  
  // Extract topic (everything after trigger or use the full prompt as context)
  let topic = '';
  let title = '';
  
  if (hasMemoryTrigger) {
    // Try to extract what follows "remember that..." or similar
    for (const p of rememberPatterns) {
      if (!hasPhrase(lower, p)) continue;
      const idx = lower.indexOf(p);
      const after = prompt.substring(idx + p.length).trim();
      if (isCapturableRemainder(after)) {
        topic = after;
        break;
      }
    }
    if (!topic) {
      return { shouldCapture: false, topic: '', title: '', summary: '', transcript: '', topics: [], tokenCount: 0, snapshotName: '' };
    }
    
    title = topic.split(/[.!]/)[0].slice(0, 50);
  } else {
    // Docs creation - use the full prompt as topic
    topic = prompt;
    title = prompt.split(/[.!]/)[0].slice(0, 50);
  }
  
  function slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  }
  
  function extractTopics(text: string): string[] {
    return text.toLowerCase().split(/[\s\W]+/).filter(w => w.length > 3).slice(0, 20);
  }
  
  const summary = topic.slice(0, 200) + (topic.length > 200 ? '...' : '');
  const topics = extractTopics(topic);
  const tokenCount = Math.ceil(topic.split(/\s+/).length * 1.3);
  
  return {
    shouldCapture: true,
    topic,
    title,
    summary,
    transcript: topic,
    topics,
    tokenCount,
    snapshotName: slugify(title),
  };
}

// First action recorded for this session (≈ when its first hook fired); null on a fresh session.
async function getSessionStartIso(sessionId: string): Promise<string | null> {
  try {
    const r = await queryOne<{ t: string | null }>('SELECT MIN(ts) AS t FROM action_history WHERE session_id = ?', [sessionId]);
    return r?.t ?? null;
  } catch { return null; }
}

export function detectPraise(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return [...PRAISE_WORDS].some(w => lower.includes(w));
}


function clapBack(action?: string): string {
  const contextPool = action ? (CLAPBACK_BY_ACTION[action] ?? []) : [];
  const useContext = contextPool.length > 0 && Math.random() < 0.4;
  const pool = useContext ? contextPool : CLAPBACK_GENERIC;
  const line = pool[Math.floor(Math.random() * pool.length)];
  return neon.matrix(`◎ ${line}`);
}

// ─── brag mode ───────────────────────────────────────────────────────────────

const BRAG_RATE = 0.05; // ~5% of status-emitting turns

const BRAG_CLEAN = [
  (name: string) => `⟳ ${name}. clean.`,
  (name: string) => `⟳ told you · ${name}`,
];

const BRAG_DORMANT = [
  (turns: number, name: string) => `⟳ ${turns}t dormant · ${name}. still warm.`,
  (turns: number, name: string) => `⟳ woke up · ${name} · ${turns}t gone. still there.`,
];

function maybeBrag(
  action: string,
  matchedMemory: MemoryNode | null,
  currentTurn: number,
): string | undefined {
  if (!matchedMemory) return;
  if (Math.random() > BRAG_RATE) return;

  const name = matchedMemory.snapshotName.slice(0, 24);
  const dormantTurns = currentTurn - matchedMemory.lastRetrievedTurn;
  const isDormant = dormantTurns > 500 && matchedMemory.lastRetrievedTurn > 0;

  if (action === 'hard_switch' || action === 'recommend_memory') {
    if (isDormant) {
      const pool = BRAG_DORMANT;
      return neon.magenta(pool[Math.floor(Math.random() * pool.length)](dormantTurns, name));
    } else {
      const pool = BRAG_CLEAN;
      return neon.magenta(pool[Math.floor(Math.random() * pool.length)](name));
    }
  }
}

// ─── Praxis invocation detection ─────────────────────────────────────────────

// Scan prompt for /slug matching a Johnny-created skill. Only matches Praxis
// skills (skill_instructions set = Johnny created it). Ignores built-in tools.
async function detectPraxisSkillInvocation(
  prompt: string,
): Promise<memoriesDbDirect.MemoryRecord | null> {
  if (!prompt.includes('/')) return null;
  const skills = await transcriptsDbDirect.getSkills();
  for (const t of skills) {
    if (!t.skill_instructions) continue;
    const mem = await memoriesDbDirect.getMemory(t.memory_id);
    if (!mem) continue;
    if (prompt.includes('/' + mem.snapshot_name)) return mem;
  }
  return null;
}

// Create skill→recent-session-memory invocation edges.
export async function emitSkillInvocationEdges(
  skill: memoriesDbDirect.MemoryRecord,
  sessionId: string,
  currentTurn: number,
  config: JohnnyConfig,
): Promise<void> {
  // Record the skill as freshly used.
  await memoriesDbDirect.recordRetrieval(skill.id, currentTurn);

  const existingOutgoing = await edgesDbDirect.getOutgoingEdges(skill.id);
  let slotsAvailable = config.topKOutgoing - existingOutgoing.length;
  if (slotsAvailable <= 0) return;

  const allRecent = await memoriesDbDirect.listMemories({ limit: 10, orderBy: 'created_at' });
  const recentMems = allRecent.filter(m =>
    m.content_type !== 'skill' &&
    m.created_at_turn !== null &&
    m.created_at_turn >= currentTurn - 5,
  );

  for (const m of recentMems) {
    if (slotsAvailable <= 0) break;
    try {
      await edgesDbDirect.createEdge({
        sourceId: skill.id, targetId: m.id, edgeType: 'skill_link', weight: 1.0, createdAtTurn: currentTurn,
      });
      slotsAvailable--;
    } catch { /* UNIQUE — already wired; doesn't consume a new slot, don't decrement */ }
  }
}

// Short additionalContext hint so Claude knows what memory backs this skill.
function buildSkillInvocationHint(skill: memoriesDbDirect.MemoryRecord): string | null {
  const topics = skill.summary ?? '';
  return [
    `[Johnny] Praxis skill invoked: ${skill.snapshot_name}`,
    `  ${topics.slice(0, 120)}`,
    `  Call johnny_recall({names: ["${skill.snapshot_name}"]}) to pull the full skill body.`,
  ].join('\n');
}

// Core — pure function from HookInput → HookOutput. Testable without stdin/stdout.
// All IO lives in runEvaluate below.
export async function evaluateHook(payload: HookInput): Promise<HookOutput> {
  const { session_id, transcript_path, cwd, prompt } = payload;

  await log(`evaluate session=${session_id}`);

  const evalStart = Date.now();
  try {
    const currentTurn = await incrementTurn(session_id);
    await log(`turn=${currentTurn} cwd=${cwd}`);

    if (isSystemNotificationPrompt(prompt)) {
      await log('system-notification prompt: passthrough (no classification, switch, or priming)');
      return {};
    }

    const [config, graph, sessionEntry] = await Promise.all([
      readConfig(),
      readGraph(INTERACTIVE_EDGE_LIMIT),
      getSessionEntry(session_id),
    ]);

    // Tracks the active memory ID to write back at the end of the turn.
    // Updated when snapshot_passthrough creates a new memory so the novelty
    // gate can compare against it on the next turn instead of always seeing null.
    let activeMemoryId: string | null = sessionEntry?.memoryId ?? null;

    // First hook fire of a fresh session → print minimal banner to stderr.
    // Detect by per-session turn === 1: incrementTurn (called above) creates
    // the session row and stamps last_prompt_at, so the older
    // `!sessionEntry?.lastPromptAt` check would never have been true.
    const isFirstFire = currentTurn === 1;
    if (isFirstFire) await printHookBanner();

    // Clap-back: keyword heuristic fires instantly (no LLM). LLM outcome
    // classification happens later (after lastAssistant is loaded) so it can
    // read both the user's words and Claude's last response.
    const praisedThisTurn = detectPraise(prompt);

    const lastCwd = sessionEntry?.lastCwd || null;  // '' from fresh row → null
    const lastPromptAt = sessionEntry?.lastPromptAt || null;
    // Rank-ordered candidates for heuristics keyword search — high-rank memories
    // surface faster (speed of recall). The classifier receives ALL memories so
    // rank never gates embedding-based recall eligibility.
    const candidates = topCandidates(graph, currentTurn, config, 30);
    const allMemories = Object.values(graph.memories);

    let matchedMemory: MemoryNode | null = null;
    let askCandidates: MemoryNode[] = [];
    let contextPressure = 0;
    let trimPressure = 0;
    let recallScore = 0;
    let embeddingScore = 0;
    let isAmbiguous = false;
    let isNewTopic = false;
    let topicSwitched = false; // hoisted for knowledge priming (set by the classifier branch)
    let action: Action;

    // Q&A continuity pre-check: if Claude's last message was a question and
    // the user's reply looks like an answer, treat as continuation.
    // Gated on CWD unchanged — a CWD change is a stronger real-shift signal
    // than Q&A pattern can override.
    const cwdChanged = lastCwd !== null && lastCwd !== cwd;
    const lastAssistant = await readLastAssistantText(transcript_path);
    const qAndA = !cwdChanged && looksLikeQuestion(lastAssistant) && looksLikeAnswer(prompt);

    if (qAndA) {
      action = 'passthrough';
      matchedMemory = null;
      try {
        const a = await analyzeSession(transcript_path);
        contextPressure = Math.round((a.estimatedTokens / config.contextLimitTokens) * 100);
      } catch { /* unreadable — 0 is safe */ }
      await log(`q&a-continuity: claude asked, user answered → continuation`);
    } else {
      // Check for memory creation intent BEFORE running heuristics
      const memoryIntent = detectMemoryIntent(prompt);
      if (memoryIntent.shouldCapture) {
        await log(`memory-intent: detected "${memoryIntent.topic}" - capturing memory`);

        try {
          const mem = await addMemory(
            memoryIntent.snapshotName,
            memoryIntent.title,
            memoryIntent.summary,
            memoryIntent.transcript,
            cwd,
            memoryIntent.tokenCount,
            memoryIntent.topics,
            currentTurn,
          );

          try { await embedMemory(mem); } catch { /* embedding optional */ }

          await log(`memory: created ${mem.snapshotName} (${mem.tokenCount} tokens)`);

          const output: HookOutput = {
            systemMessage: neon.cyan('◈') + ink.fg(' memory saved') + neon.cyan(` · ${mem.snapshotName}\n`) +
              dim.fg(`  topics: ${mem.topics.slice(0, 5).join(', ')}\n`),
          };

          return output;
        } catch (err) {
          await log(`memory-intent: capture failed, falling through to recall: ${err}`);
          // fall through — do not return; let heuristics/classifier/recall run for this turn
        }
      }

      const hSignals = runHeuristics(prompt, cwd, lastCwd, lastPromptAt, candidates, config);

      let cSignals: Awaited<ReturnType<typeof runClassifier>> = { embeddingScore: 0, matchedMemory: null, candidates: [], isAmbiguous: false, llmVote: null, rawLabel: null, source: 'offline', embedderFailed: false };
      if (allMemories.length > 0) {
        try {
          const currentSummary = (lastAssistant ?? '').slice(0, 600);
          // Never offer this session's own memories back to it (junk intent captures and fresh snapshots
          // matched the very next prompt): candidates are memories created before the session's first turn.
          const sessionStart = await getSessionStartIso(session_id);
          const eligible = sessionStart ? allMemories.filter(m => !m.createdAt || m.createdAt < sessionStart) : allMemories;
          cSignals = await runClassifier(prompt, eligible, currentSummary);
          await log(`classifier: embeddingScore=${cSignals.embeddingScore.toFixed(3)} llmVote=${cSignals.llmVote ?? 'null'} rawLabel=${cSignals.rawLabel ?? 'null'} source=${cSignals.source}`);
        } catch (err) {
          await log(`classifier failed, using heuristic result: ${err}`);
        }
      }

      // Merge signals into a single recallScore.
      // matchedMemory: prefer embedding match (more accurate) over keyword match.
      // candidates: prefer embedding candidates; fall back to keyword candidates.
      const recall = computeScore(
        hSignals.keywordScore,
        cSignals.embeddingScore,
        cSignals.matchedMemory ?? hSignals.matchedMemory,
        cSignals.candidates.length ? cSignals.candidates : hSignals.candidates,
        hSignals.isAmbiguous || cSignals.isAmbiguous,
        hSignals.isNewTopic,
        { cwdChanged: hSignals.cwdChanged, longGap: hSignals.longGap },
        cSignals.llmVote,
      );

      recallScore = recall.score;
      embeddingScore = recall.embeddingScore;
      isAmbiguous = recall.isAmbiguous;
      isNewTopic = recall.isNewTopic;
      matchedMemory = recall.matchedMemory;
      askCandidates = recall.candidates;

      // When the embedder itself errored (Ollama /api/embeddings failure, not just "no
      // memory scored well"), there was no real candidate list to check the LLM's vote
      // against — don't let an unconfirmed llmVote alone drive a switch in that case.
      // The heuristic path (hSignals.isNewTopic) doesn't depend on Ollama and still applies.
      const isTopicSwitch = (!cSignals.embedderFailed && (cSignals.llmVote === 'switch' || cSignals.llmVote === 'new')) || hSignals.isNewTopic;

      topicSwitched = isTopicSwitch;
      await log(`recall: score=${recallScore.toFixed(3)} embedding=${embeddingScore.toFixed(3)} ambiguous=${isAmbiguous} newTopic=${isNewTopic} topicSwitch=${isTopicSwitch}`);

      try {
        const a = await analyzeSession(transcript_path);
        contextPressure = Math.round((a.estimatedTokens / config.contextLimitTokens) * 100);
        trimPressure = Math.min(100, Math.round(a.contextUsedPercent));
      } catch { /* unreadable — 0 is safe */ }

      action = decide({
        recallScore,
        embeddingScore,
        isAmbiguous,
        isTopicSwitch,
        contextPressure,
        trimPressure,
        matchedMemory,
        candidates: askCandidates,
        currentTurn,
      });
      // hard_switch overwrites the live transcript; only run it when explicitly enabled.
      action = gateHardSwitch(action, config);
      // Make the weak-match gate visible: a boosted score can clear the thresholds while the raw
      // cosine is too low to show the hint, which otherwise looks like "high score, nothing happened".
      if (matchedMemory && hintTier(embeddingScore, isTopicSwitch) === 'none' && recallScore >= OFFER_THRESHOLD) {
        await log(`hint suppressed: raw cosine ${embeddingScore.toFixed(3)} < ${isTopicSwitch ? MIN_SWITCH_HINT_COSINE : MIN_HINT_COSINE} (boosted score ${recallScore.toFixed(3)}) — would have matched "${matchedMemory.title}"`);
      }
    }

    await log(`action=${action} cmvPressure=${Math.round(trimPressure ?? 0)}% limitPressure=${Math.round(contextPressure)}%`);

    const subjectCount = Object.keys(graph.memories).length;

    // Record the action as soon as its final value is known — BEFORE invoking
    // the (potentially heavy) side-effecting function below, not after the
    // whole switch. hard_switch/recommend_memory/suggest_memories can run a
    // full snapshot/embedding pipeline (up to ~170 Ollama calls on a large
    // session); on top of an already-tight 15s UserPromptSubmit hook timeout,
    // that execution can get the process SIGKILLed before a post-switch write
    // would ever run — silently losing the row with no error logged. Recording
    // first means the decision is captured even if the action's own work later
    // times out. Idempotent (via `recorded`) so the post-switch fallback call
    // below is a no-op once a case has already recorded.
    let recorded = false;
    const recordActionNow = async () => {
      if (recorded) return;
      recorded = true;
      try {
        await recordAction({
          sessionId: session_id,
          turn: currentTurn,
          recallScore: recallScore > 0 ? recallScore : null,
          cmvPressure: Math.round(trimPressure ?? 0),
          limitPressure: Math.round(contextPressure),
          action,
          matchedMemoryId: matchedMemory?.id ?? null,
          durationMs: Date.now() - evalStart,
        });
      } catch (err) {
        await log(`recordAction failed: ${err}`);
      }
    };

    let output: HookOutput;
    switch (action) {
      case 'passthrough': {
        await recordActionNow();
        output = {};
        break;
      }

      case 'snapshot_passthrough': {
        // Coordinate with post-turn.ts via the shared DB cooldown so both paths
        // don't snapshot independently within the same 2-minute window.
        if (await claimSnapshotWindow(session_id, DEFAULT_SNAPSHOT_COOLDOWN_MS)) {
          await recordActionNow();
          const { output: o, memoryId: newMemId } = await snapshot(transcript_path, session_id, cwd, currentTurn, false, evalStart + SNAPSHOT_EMBED_BUDGET_MS);
          output = o;
          if (newMemId) activeMemoryId = newMemId;
        } else {
          // post-turn already snapshotted recently — record the true outcome,
          // not the suppressed snapshot_passthrough decision.
          action = 'passthrough';
          await recordActionNow();
          output = {};
        }
        break;
      }

      case 'offer': {
        await recordActionNow();
        // touchMemory lives inside offer() — it must only fire when the surface
        // actually ships, not when cooldown suppresses it.
        // Pass raw embeddingScore (pre-boost) for cooldown and display percentage.
        output = await offer(matchedMemory!, embeddingScore || recallScore, session_id, currentTurn, config);
        break;
      }

      case 'recommend_memory': {
        await recordActionNow();
        output = await recommendMemory(prompt, matchedMemory!, transcript_path, session_id, cwd, embeddingScore || null);
        await touchMemory(matchedMemory!.id, currentTurn, config);
        break;
      }

      case 'hard_switch': {
        await recordActionNow();
        output = await hardSwitch(transcript_path, session_id, cwd, prompt, matchedMemory!, currentTurn);
        await touchMemory(matchedMemory!.id, currentTurn, config);
        break;
      }

      case 'suggest_memories': {
        // Record before the blend runs — matchedMemory here is still the
        // pre-blend value (blend.blendMemory is only known after suggestMemories()
        // returns), which is fine: it's informational metadata on the row, not
        // load-bearing for the merge itself.
        await recordActionNow();
        // Ambiguous between multiple candidates — don't ask the user, merge.
        // Claude sees summaries of all via additionalContext and full bodies
        // via JSONL append. Touch every candidate and co-reinforce their edges.
        const blend = await suggestMemories(prompt, askCandidates, transcript_path, session_id, cwd, currentTurn);
        output = blend.output;
        const coIds = askCandidates.map(m => m.id);
        for (const mem of askCandidates) {
          await touchMemory(mem.id, currentTurn, config, coIds);
        }
        // Treat the blend's own merged memory as the active one for session-map.
        matchedMemory = blend.blendMemory ?? askCandidates[0] ?? null;
        break;
      }

      default:
        output = passthrough();
    }

    // Fallback for the unreachable `default` case (decide() never actually
    // returns an unhandled action) — no-ops if a case above already recorded.
    await recordActionNow();

    // Bootstrap landscape hint — first hook fire of a fresh session, project
    // has memories. One-shot orientation prepended to whatever additionalContext
    // the action already produced. They serve different purposes: bootstrap is
    // the broad project landscape, action emission is "look at THIS memory."
    if (isFirstFire) {
      try {
        // If turn-1 action surfaced a specific memory (recommend_memory / hard_switch
        // / suggest_memories), exclude it from the bootstrap recents so the stacked
        // emission doesn't describe the same memory twice.
        const excludeIds = matchedMemory ? [matchedMemory.id] : [];
        const bootstrap = buildBootstrapHint(graph, cwd, { excludeIds });
        if (bootstrap) {
          output.additionalContext = output.additionalContext
            ? `${bootstrap.text}\n\n---\n\n${output.additionalContext}`
            : bootstrap.text;
          for (const id of bootstrap.surfacedMemoryIds) {
            await recordMemorySurfaced(session_id, id);
          }
          logHintEmission({
            sessionId: session_id,
            form: 'bootstrap',
            suggestedMemoryIds: bootstrap.surfacedMemoryIds,
            tokenEstimate: Math.ceil(bootstrap.text.length / 4),
          });
          await log(`bootstrap-hint: emitted (${bootstrap.surfacedMemoryIds.length} recents, ${bootstrap.clusterTopics.length} cluster topics)`);
        }
      } catch (err) {
        await log(`bootstrap-hint failed: ${err}`);
      }
    }

    // Praxis invocation detection — check if user invoked a Praxis-created skill
    // via /slug syntax. Only matches skills Johnny created (has skill_instructions set).
    try {
      const invokedSkill = await detectPraxisSkillInvocation(prompt);
      if (invokedSkill) {
        await emitSkillInvocationEdges(invokedSkill, session_id, currentTurn, config);
        const skillHint = buildSkillInvocationHint(invokedSkill);
        if (skillHint) {
          output.additionalContext = output.additionalContext
            ? `${output.additionalContext}\n\n---\n\n${skillHint}`
            : skillHint;
        }
        await log(`praxis: invoked ${invokedSkill.snapshot_name}`);
      }
    } catch (err) {
      await log(`praxis invocation detection failed: ${err}`);
    }

    // ── Automatic knowledge priming ("subconscious recall") ───────────────────
    // Compiled models/observations (verified in the background by `johnny synth`)
    // matched against this prompt by embedding only — no LLM on this path. A
    // short distilled digest is prepended when a trusted item is relevant, not
    // recently surfaced, and not already in the always-loaded CLAUDE.md/MEMORY.md.
    // Gated by config.knowledge.prime (instant rollback); never blocks the hook.
    try {
      const kcfg = await readKnowledgeConfig();
      if (kcfg.prime && !qAndA && prompt.trim().length >= 12) {
        const trigger: PrimeTrigger = isFirstFire ? 'first-prompt' : topicSwitched ? 'topic-switch' : 'continuation';
        const promptEmbedding = await embed(prompt);
        const prime = await computePrime({
          promptEmbedding, promptText: prompt, cwd, sessionId: session_id, turn: currentTurn,
          trigger, config: kcfg,
        });
        if (prime) {
          output.knowledgeContext = prime.additionalContext;
          logHintEmission({
            sessionId: session_id, form: 'knowledge', suggestedMemoryIds: prime.refs as unknown as string[],
            topScore: prime.topScore, tokenEstimate: Math.ceil(prime.additionalContext.length / 4),
          });
          await log(`prime: ${trigger} · ${prime.refs.join(', ')} · sim=${prime.topScore.toFixed(3)}`);
          await recordPrimeEvent({ sessionId: session_id, trigger, outcome: 'primed', refs: prime.refs as unknown as string[], topScore: prime.topScore });
        } else {
          await log(`prime: none · ${trigger}`);
          await recordPrimeEvent({ sessionId: session_id, trigger, outcome: 'none' });
        }
      }
    } catch (err) {
      await log(`prime failed (ignored): ${err}`);
      await recordPrimeEvent({ sessionId: session_id, trigger: isFirstFire ? 'first-prompt' : topicSwitched ? 'topic-switch' : 'continuation', outcome: 'failed', error: String(err) });
    }

    // ── Outcome-based memory reinforcement ────────────────────────────────────
    // Use the local LLM to evaluate both the user's prompt and Claude's last
    // response. Praise reinforces the associated memories.
    // Best-effort: never blocks the hook output.
    //
    // The 'failure' verdict used to also invalidate edges among the involved
    // memories, on the theory that mistakes are as worth remembering as successes.
    // Removed 2026-08-24: qwen2.5:3b's failure/mistake criterion ("assistant
    // acknowledges a mistake or apologizes for harm done") reliably fires on
    // ordinary risk/caution/refusal language — e.g. Claude declining a destructive
    // action and explaining why — which reads lexically like an admission of harm
    // to a small model even though it's the correct outcome. Reproduced directly
    // against a real (benign-prompt, refusal-response) pair from this session's
    // log, and the log showed a ~12:1 failure:praise ratio (298:25) sustained over
    // three months — a systemic bias, not an occasional misfire. Same shape as the
    // 2026-06-07 new_session removal ([[feedback_johnny_decision_engine_changes]]):
    // removing the unreliable negative-signal action was judged lower-risk than
    // tuning the classifier prompt, since invalidateEdge() damage isn't easily
    // undone once wrong verdicts have already accumulated in trust scores.
    try {
      const assistantText = lastAssistant ?? '';
      const outcome = await classifyOutcome(prompt, assistantText);
      const idsInvolved = [
        sessionEntry?.memoryId,
        matchedMemory?.id,
        ...(sessionEntry?.surfacedMemories ?? []),
      ].filter((id): id is string => !!id);
      const uniqueIds = [...new Set(idsInvolved)];

      if (outcome === 'praise' && uniqueIds.length > 0) {
        for (const id of uniqueIds) {
          const coIds = uniqueIds.filter(x => x !== id);
          await touchMemory(id, currentTurn, config, coIds);
        }
        await log(`outcome-reinforce: praise · ${uniqueIds.length} memor${uniqueIds.length === 1 ? 'y' : 'ies'} strengthened`);
      }
    } catch (err) {
      await log(`outcome-reinforce failed: ${err}`);
    }

    const extras = [
      praisedThisTurn ? clapBack(action) : undefined,
      maybeBrag(action, matchedMemory ?? null, currentTurn),
    ].filter(Boolean) as string[];
    if (extras.length > 0) {
      const extra = extras.join('\n');
      output.systemMessage = output.systemMessage ? `${output.systemMessage}\n${extra}` : extra;
    }
    // Stamp every outgoing message with johnny identity + live context stats
    const subjectLabel = subjectCount === 1 ? 'subject' : 'subjects';
    const meta = dim.fg(` · ${subjectCount} ${subjectLabel} · t${currentTurn}`);
    if (output.systemMessage) {
      const lines = output.systemMessage.split('\n');
      lines[0] = neon.matrix('johnny') + ink.fg(' · ') + lines[0] + meta;
      output.systemMessage = lines.join('\n');
    } else {
      output.systemMessage = neon.matrix('johnny') + meta;
    }

    await setActiveSession(session_id, cwd, activeMemoryId, action);
    return output;
  } catch (err) {
    await log(`evaluate FATAL: ${err}`);
    return { systemMessage: neon.red('×') + dim.fg(' johnny crashed · falling through') };
  }
}

// Hooks are excluded from index.ts's centralized exit handling. The DB layer is
// local, but llm.ts's Ollama fetch() calls keep an undici keep-alive socket
// open after the response, which keeps the event loop (and the
// process) alive well past Claude Code's hook timeout, so the already-
// written stdout output gets discarded. Writing with a flush callback and
// then forcing exit sidesteps needing to track down and close every such
// handle individually.
function writeAndExit(json: string): void {
  process.stdout.write(json, () => process.exit(0));
}

export async function runEvaluate(): Promise<void> {
  exitIfBypassed();

  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  let payload: HookInput;
  try {
    payload = JSON.parse(input);
  } catch {
    writeAndExit(JSON.stringify({ systemMessage: neon.red('×') + dim.fg(' johnny: invalid hook input') }));
    return;
  }

  const output = await evaluateHook(payload);
  // The forced "go search" nudge on every quiet turn is retired by default
  // (config.knowledge.retireSearchNudge): relevant knowledge now arrives on its own
  // and searching stays available for introspection. (It was also silently dead:
  // see utils/hook-output.ts — reviving it would have added per-turn noise.)
  const kc = await readKnowledgeConfig().catch(() => null);
  const legacy = !!kc?.legacyHints;
  if (legacy && !output.additionalContext && !kc?.retireSearchNudge) output.additionalContext = MEMORY_SEARCH_NUDGE;
  writeAndExit(serializeHookOutput(output, 'UserPromptSubmit', { legacyHints: legacy }));
}
