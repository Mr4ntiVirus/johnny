// Johnny-owned types. CMV types are imported from src/vendor/cmv/types/index.ts.

export type MemoryId = string;

export interface Edge {
  weight: number;
  coRetrievalCount: number;
  lastReinforcedTurn: number;
  lastReinforcedAt: string;
  invalidationCount: number;
  lastInvalidatedTurn: number | null;
  // computed on-read: lift, trust, effective_weight
}

// MemoryNode — the graph-loop shape. PageRank, edge reinforcement, and any
// code iterating every memory for structural work should use this type.
// Deliberately excludes transcript + embedding so hot paths never read
// large TEXT/BLOB columns from SQLite. Topics stay on the node because
// they're small (a handful of short strings) and are needed by the intent
// classifier on every prompt.
export interface MemoryNode {
  id: MemoryId;
  snapshotName: string;
  title: string;
  summary: string;
  projectPath: string;
  sourceUri: string | null;
  tokenCount: number;
  topics: string[];

  retrievalCount: number;
  lastRetrievedTurn: number;
  lastRetrievedAt: string;
  createdAtTurn: number;
  createdAt: string;

  outgoingEdges: Record<MemoryId, Edge>;
  incomingEdges: Record<MemoryId, Edge>;

  rank: number;
  rankUpdatedAtTurn: number;
}

// MemoryFull — adds transcript + embedding hydrated from the transcripts
// table. Use when injecting, displaying, or running similarity search.
export interface MemoryFull extends MemoryNode {
  transcript: string;
  embedding: number[] | null;
}

// Back-compat alias. Prefer MemoryFull or MemoryNode at new call sites.
export type Memory = MemoryFull;

export interface MemoryGraph<T extends MemoryNode = MemoryNode> {
  version: number;
  rankUpdatedAtTurn: number;
  memories: Record<MemoryId, T>;
}

export interface JohnnyState {
  turnCounter: number;
  firstTurnAt: string;
  lastTurnAt: string;
}

export interface SessionMapEntry {
  memoryId: MemoryId | null;
  projectPath: string;
  lastPromptAt: string;
  lastCwd: string;
  lastAction?: Action;
  // Memories Claude has been made aware of this session — either pushed via
  // digest in additionalContext, appended to the JSONL transcript, or pulled
  // by Claude via johnny_recall. Phase G hint generation excludes anything
  // already in this set so the same memory isn't re-surfaced.
  surfacedMemories?: MemoryId[];
}

export interface SessionMap {
  activeSessionId: string | null;
  sessions: Record<string, SessionMapEntry>;
}

export interface JohnnyConfig {
  reinforcementDelta: number;
  invalidationLambda: number;
  activationTau: number;
  pageRankDamping: number;
  topKOutgoing: number;
  rankRefreshEveryTurns: number;
  pruneLiftFloor: number;
  pruneTrustFloor: number;
  pruneDormancyTurns: number;
  similarityAlpha: number;
  similarityBeta: number;
  similarityGamma: number;
  similarityDelta: number;
  intentGapMinutes: number;
  // Cosine-similarity floor above which a fresh snapshot candidate is judged
  // redundant vs the session's previous snapshot and skipped. Lenient by design
  // — sleep-phase schema-extraction clusters over-capture downstream.
  snapshotNoveltyThreshold: number;
  // Initial weight for derived_from provenance edges (Phase G). Set higher than
  // baseline (0.15) because lineage is an active association — Claude actually
  // pulled the parent's chunks to build the child. Default mirrors a single
  // reinforcement event.
  derivedFromInitialWeight: number;
  // Cooldown turns: a surfaced memory is held back from re-surfacing for this
  // many session turns. Break condition (a) — once elapsed, eligible again.
  cooldownTurns: number;
  // Subject-shift threshold: cosine similarity between current prompt and
  // memory M above which break condition (b) fires — user is asking about M's
  // domain strongly enough that cooldown is overridden regardless of recency.
  // Set higher than the standard surface threshold so middle-band candidates
  // remain rate-limited but bullseye matches always get through.
  subjectShiftThreshold: number;
  // Offer band lower bound: similarity above which we surface a memory as a
  // hint-only `offer` (cheapest action — additionalContext name+topics+call
  // instructions, no JSONL append). Below this floor decide() returns
  // passthrough; above the classifier's switch threshold (~0.75) a stronger
  // action (recommend_memory) takes over.
  offerThreshold: number;
  // Token budget against which contextPressure is computed. CMV's vendored
  // analyzer hardcodes 200_000 (classic Sonnet 4) which is stale on current
  // Opus/Sonnet/Haiku 4.x models with 1M windows. Johnny recomputes pressure
  // from analysis.estimatedTokens against this knob — overrides the vendor
  // default without editing vendor code. Set lower if you're on a 200k plan.
  contextLimitTokens: number;
  // Weight increment per MCP co-recall event. Lower than reinforcementDelta
  // (1.0) because recalls include speculative exploration, not just confirmed
  // relevance. 0.5 = each co-recall is worth half a hook-triggered surface.
  mcpRecallReinforcementDelta: number;
  // Max memories to co-reinforce per recall call. Caps O(n²) edge creation:
  // default limit=8 tiles could produce 56 directed edges per call without this.
  mcpRecallMaxCoReinforce: number;
  // Praxis: minimum cluster score to propose a skill candidate. Score =
  // cohesion × recurrence × density (all 0..1). Default tuned to filter noise
  // while surfacing genuinely repeated patterns.
  minSkillClusterScore: number;
  // Praxis: minimum number of memories that must share a topic core before
  // a cluster is considered a skill candidate.
  minSkillClusterSize: number;
  // Knowledge layer (facts / observations / mental models). Partial in config.json;
  // merged over defaults by src/knowledge/config.ts.
  knowledge?: Partial<KnowledgeConfig>;
  // hard_switch REWRITES the live session transcript with an old snapshot. Off by default since
  // 2026-10-13: the 3B topic-switch classifier fired it ~18x/day, often on unrelated memories, and
  // it clobbered the session file. When off, the decision is demoted to recommend_memory (additive).
  allowHardSwitch?: boolean;
}

export interface KnowledgeConfig {
  // Automatic synthesis: a launchd heartbeat runs `johnny synth run` every few hours so facts,
  // observations and mental models are built without anyone running a command. Set by
  // `johnny setup` once the user has agreed (it sends memory text to the `claude` CLI);
  // undefined means the question has not been answered, false means declined.
  autoSynth?: boolean;
  // Automatic priming: precompiled models/observations injected via the hook.
  // The rollback switch — false restores pre-knowledge behaviour instantly.
  prime: boolean;
  // Min cosine for a prime on a trigger turn (first prompt / topic switch).
  primeMinSimilarity: number;
  // Min cosine for a prime on an ordinary continuation turn.
  primeContinuationSimilarity: number;
  // Min cosine for a PreToolUse prime: a bare shell command vs prose scores low (~0.45-0.6),
  // so this is lower than the prompt thresholds; once-per-context-epoch keeps it quiet.
  primeToolSimilarity: number;
  primeMaxChars: number;
  // Observations are primed only when backed by at least this many distinct sessions.
  primeMinProof: number;
  // Stop forcing the per-turn "please search memory" nudge once priming is live.
  retireSearchNudge: boolean;
  // Deliver Johnny's older "go call johnny_recall" hints (offer/recommend/suggest/hard-switch
  // announcements, bootstrap, praxis) to the model. They were silently dropped for months (see
  // src/utils/hook-output.ts); reviving them is an explicit opt-in, off by default.
  legacyHints: boolean;
  synth: {
    defaultModel: string;
    models: Partial<Record<'extract' | 'consolidate' | 'model' | 'verify' | 'name', string>>;
    maxCallsPerRun: number;
    maxCallsPerDay: number;
    maxTokensPerRun: number;
    timeBoxMinutes: number;
    memoriesPerBatch: number;
    // Extraction slice per run: after this many memories the run moves on to consolidation and
    // model refresh, so a large backlog can't starve the later phases of the budget.
    maxMemoriesPerRun: number;
    windowsPerCall: number;
    // Parallel extraction calls (independent windows); the governor still meters every call.
    concurrency: number;
    verifySampleRate: number;
    // Auto-pause a step when this share of its output is rejected/unsupported.
    pauseRejectRate: number;
  };
}

// JSONL entry types for hard-switch surgery
export interface SummaryEntry {
  type: 'summary';
  summary: string;
  timestamp?: string;
}

export interface CompactBoundaryEntry {
  type: 'system';
  subtype: 'compact_boundary';
  summary: string;
  timestamp?: string;
}

// Hook I/O
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt: string;
}

export interface HookOutput {
  // LEGACY hints (offer / recommend / suggest / hard-switch announcements / bootstrap / nudge).
  // Only delivered to the model when config.knowledge.legacyHints is true.
  additionalContext?: string;
  // Compiled-knowledge priming digest (internal; merged in serializeHookOutput, never printed as a key).
  knowledgeContext?: string;
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
}

// Decision engine types
export type Action =
  | 'passthrough'
  | 'trim'
  | 'snapshot_passthrough'
  | 'offer'
  | 'recommend_memory'
  | 'suggest_memories'
  | 'hard_switch'
  | 'mcp_recall';

export interface DecisionContext {
  recallScore: number;      // composite 0-1 from scorer.computeScore()
  embeddingScore: number;   // raw cosine before boosts — threaded to offer() for cooldown + display
  isAmbiguous: boolean;     // two memories scored close and both meaningful
  isTopicSwitch: boolean;   // LLM confirmed prompt is distant from current session context
  contextPressure: number;  // 0-100, relative to model's actual context limit
  trimPressure?: number;    // 0-100, relative to 200k baseline
  matchedMemory: MemoryNode | null;
  candidates: MemoryNode[];
  currentTurn: number;
}
