import type { MemoryNode } from '../types.js';
import type { JohnnyConfig } from '../types.js';

export interface HeuristicSignals<T extends MemoryNode = MemoryNode> {
  keywordScore: number;           // 0-1, best keyword overlap against any memory
  matchedMemory: T | null;        // top-scoring memory (null if no meaningful match)
  candidates: T[];                // top matches for ambiguous case
  isAmbiguous: boolean;           // two memories scored close and both meaningful
  isNewTopic: boolean;            // cwd changed but no meaningful keyword match
  cwdChanged: boolean;
  longGap: boolean;
}

// Common English stopwords + procedural filler that kept causing false matches
// (e.g. "and" appearing in a memory summary scored as a keyword hit). We want
// keyword overlap to mean shared *content* words, not shared grammar.
const STOPWORDS = new Set([
  'the','and','but','for','are','was','you','your','our','its','his','her',
  'has','had','have','will','can','could','should','would','may','might',
  'about','from','into','with','over','under','this','that','they','them',
  'these','those','who','whom','why','how','when','where','what','which',
  'not','all','any','some','one','two','new','old','own','yet','too','still',
  'also','just','like','than','then','now','only','very','more','most','much',
  'been','being','into','onto','upon','per','via','such','etc','ref','use',
  'user','claude','johnny','session','0418','0419','0420',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[\s\W]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits++;
  return hits / Math.min(a.size, b.size);
}

export function runHeuristics<T extends MemoryNode>(
  prompt: string,
  cwd: string,
  lastCwd: string | null,
  lastPromptAt: string | null,
  memories: T[],
  config: JohnnyConfig,
): HeuristicSignals<T> {
  const promptTokens = tokenize(prompt);

  const cwdChanged = lastCwd !== null && lastCwd !== cwd;

  let longGap = false;
  if (lastPromptAt) {
    const gapMinutes = (Date.now() - new Date(lastPromptAt).getTime()) / 60_000;
    longGap = gapMinutes > config.intentGapMinutes;
  }

  const scored = memories.map(mem => {
    const memTokens = tokenize([mem.summary, ...mem.topics].join(' '));
    return { mem, score: overlapScore(promptTokens, memTokens) };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  // No meaningful match + CWD changed → new topic
  if (cwdChanged && (!best || best.score < 0.1)) {
    return {
      keywordScore: best?.score ?? 0,
      matchedMemory: null,
      candidates: [],
      isAmbiguous: false,
      isNewTopic: true,
      cwdChanged,
      longGap,
    };
  }

  // Ambiguous: top two candidates are close and both meaningful
  if (
    best && second &&
    best.score > 0.15 && second.score > 0.15 &&
    (best.score - second.score) < 0.1
  ) {
    const firstName = (best.mem.topics[0] ?? best.mem.snapshotName).toLowerCase();
    const secondName = (second.mem.topics[0] ?? second.mem.snapshotName).toLowerCase();

    // Same topic name or same project — not a real ambiguity, treat as continuation signal
    if (firstName === secondName || (best.mem.projectPath === cwd && second.mem.projectPath === cwd)) {
      return {
        keywordScore: best.score,
        matchedMemory: best.mem,
        candidates: [best.mem],
        isAmbiguous: false,
        isNewTopic: false,
        cwdChanged,
        longGap,
      };
    }

    return {
      keywordScore: best.score,
      matchedMemory: null,
      candidates: [best.mem, second.mem],
      isAmbiguous: true,
      isNewTopic: false,
      cwdChanged,
      longGap,
    };
  }

  return {
    keywordScore: best?.score ?? 0,
    matchedMemory: best && best.score > 0.1 ? best.mem : null,
    candidates: best && best.score > 0.1 ? [best.mem] : [],
    isAmbiguous: false,
    isNewTopic: false,
    cwdChanged,
    longGap,
  };
}
