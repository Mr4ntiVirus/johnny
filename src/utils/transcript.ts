import * as os from 'node:os';
import { readJsonlLines } from './jsonl.js';

interface JsonLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  content?: unknown;
}

export interface StagePlayOptions {
  userName?: string;
  assistantName?: string;
  johnnyName?: string;
}

function getUserDisplayName(): string {
  return (
    process.env.JOHN_DISPLAY_NAME ??
    process.env.CLAUDE_USER_NAME ??
    process.env.USER ??
    os.userInfo().username ??
    'User'
  );
}
export { getUserDisplayName };

/**
 * Converts JSONL transcript to stage-play format.
 * 
 * Example output:
 * Alice: do you remember the work we did last week?
 * Johnny: [suggest tool] use your Johnny Recall MCP tool to recall...
 * Claude: Hmm let me check my memories. Got it.
 * 
 * Features:
 * - Uses display name instead of "User"
 * - Tool uses replaced with [tool: name] tags
 * - Tool results replaced with [tool result] tags
 * - Thinking blocks removed for clean output
 */
// ── Noise patterns: storage hygiene for memory transcripts ─────────────────
//
// Goal: persisted transcripts contain prose, not machine-language scaffolding.
// Each filter is a small named transform; they compose in a deliberate order.
// All operate on either a single line or a block of multi-line content.
// See feedback_memory_signal_noise.md for the principle.

// Trimmed-stub markers — emitted by CMV's trimmer when a large tool result
// was stripped. Embedding "[Trimmed tool result: ~4955 chars]" is worse than
// absence (it dilutes the vector with no meaning).
const TRIMMED_STUB_RE = /^\[Trimmed tool result:\s*~?\d+\s*chars\]$/;

// Edit-success boilerplate — "The file /path has been updated successfully.
// (file state is current in your context — no need to Read it back)" repeats
// verbatim hundreds of times per session. One occurrence is informative; a
// hundred is pure dilution.
const EDIT_SUCCESS_RE = /(has been updated successfully\.|file state is current in your context)/;

// Compaction-continuation prefix — Claude Code injects a "This session is
// being continued from a previous conversation that ran out of context"
// summary as a synthetic user-role message. The body is real signal (it
// describes prior decisions / file changes / task state), but the
// `alice:` attribution is false. Re-attribute to a neutral marker.
const CONTINUATION_PREFIX_RE = /^This session is being continued from a previous conversation/;

// Local-command caveat — XML-tagged scaffolding that tells Claude not to
// respond to a wrapped block. Pure framing; strip the wrapper, keep nothing
// (the user prompt that follows is captured separately).
const LOCAL_COMMAND_CAVEAT_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;

// Persisted-output framing — wraps a "Output too large (NkB). Full output
// saved to: …" boilerplate around tool-result spillover. The path may carry
// signal; the framing doesn't.
const PERSISTED_OUTPUT_FRAME_RE = /<persisted-output>[\s\S]*?<\/persisted-output>/g;

// RTF / native-format escape sequences. When a user pastes from a
// rich-text source, control sequences like `\cocoatextscaling0` and
// `\fonttbl\f0\fswiss\fcharset0` survive into JSONL. Pure binary noise.
const RTF_FINGERPRINT_RE = /\\(?:cocoatextscaling|cocoaplatform|fonttbl|fcharset|fswiss|cocoascreenfonts)/;

// Read-tool line-number prefix — `2\timport * as path...` or `141:export`.
// Strip the number; keep the line content. Numbers are addressing metadata,
// not content; the code itself IS the signal.
const LINE_NUMBER_PREFIX_RE = /^\s*\d+(?:[\t:])\s?/;

// How much of a tool result body to keep. Tool results are largely throwaway
// — the assistant's text after the call is what carries the decision. Keep a
// short head for retrieval keywords; drop the rest.
const TOOL_RESULT_HEAD_CHARS = 200;

// Strip recognized scaffolding wrappers from arbitrary text. Order matters:
// remove longest enclosing tags first so inner pattern strippers don't see
// the wrapper edges.
function stripScaffolding(text: string): string {
  return text
    .replace(LOCAL_COMMAND_CAVEAT_RE, '')
    .replace(PERSISTED_OUTPUT_FRAME_RE, '');
}

// Apply line-level filters: drop empty / RTF / line-number-only lines, strip
// line-number prefixes from code excerpts. Operates on a multi-line block.
function cleanLineLevel(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw;
    if (!line.trim()) continue;
    if (RTF_FINGERPRINT_RE.test(line)) continue;
    // `\d+\t` or `\d+:` with NO content after = pure addressing artifact.
    if (/^\s*\d+\s*[\t:]\s*$/.test(line)) continue;
    // Strip the prefix from numbered code lines.
    out.push(line.replace(LINE_NUMBER_PREFIX_RE, ''));
  }
  return out.join('\n');
}

// Full prose hygiene pass: scaffolding → line-level → trim.
function cleanProse(text: string): string {
  return cleanLineLevel(stripScaffolding(text)).trim();
}

// Extract clean tool-result text from a tool_result block, ignoring
// tool_use_id / type / is_error metadata. Returns null when the block is a
// trimmed stub, edit-success boilerplate, or has no useful content after
// hygiene passes.
function cleanToolResultContent(rawContent: unknown): string | null {
  let raw: string | null = null;
  if (typeof rawContent === 'string') {
    raw = rawContent;
  } else if (Array.isArray(rawContent)) {
    const texts: string[] = [];
    for (const b of rawContent) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: string }).text;
        if (t) texts.push(t);
      }
    }
    raw = texts.join('\n');
  }
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (TRIMMED_STUB_RE.test(trimmed)) return null;
  // Edit-success / file-state-is-current boilerplate is dropped wholesale —
  // not even the file path is signal worth keeping; it appears in the
  // preceding [tool: Edit] / [tool: Write] markers anyway.
  if (EDIT_SUCCESS_RE.test(trimmed)) return null;
  const cleaned = cleanProse(trimmed);
  if (!cleaned) return null;
  return cleaned;
}

function formatToolResult(rawContent: unknown): string | null {
  const clean = cleanToolResultContent(rawContent);
  if (clean === null) return null;
  const head = clean.length > TOOL_RESULT_HEAD_CHARS
    ? clean.slice(0, TOOL_RESULT_HEAD_CHARS).trimEnd() + '…'
    : clean;
  return `[tool result: ${head}]`;
}

// User-typed prose may also carry scaffolding (RTF paste, local-command
// caveats). Apply the same hygiene before persisting. Re-attributes a
// compaction-continuation summary so the body survives but the false
// `alice:` attribution doesn't.
function cleanUserText(text: string): { label: 'user' | 'continuation'; body: string } | null {
  const cleaned = cleanProse(text);
  if (!cleaned) return null;
  if (CONTINUATION_PREFIX_RE.test(cleaned)) {
    return { label: 'continuation', body: cleaned };
  }
  return { label: 'user', body: cleaned };
}

export function toStagePlayFormat(jsonl: string, options?: StagePlayOptions): string {
  if (!jsonl) return '';

  const userName = options?.userName ?? getUserDisplayName();
  const assistantName = options?.assistantName ?? 'Claude';
  const johnnyName = options?.johnnyName ?? 'Johnny';

  // Check if already stage-play format
  const firstLine = jsonl.split('\n')[0]?.trim();
  if (firstLine?.startsWith(`${userName}:`) || firstLine?.startsWith(`${assistantName}:`)) {
    return jsonl;
  }

  const lines = jsonl.split('\n').filter(l => l.trim());
  const parts: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as JsonLine;
      const role = obj.type ?? obj.message?.role;
      const content = obj.message?.content ?? obj.content ?? '';

      const emitUser = (text: string) => {
        const cleaned = cleanUserText(text);
        if (!cleaned) return;
        const label = cleaned.label === 'continuation'
          ? '[continuation summary]'
          : `${userName}:`;
        parts.push(`${label} ${cleaned.body}`);
      };

      const emitAssistant = (text: string) => {
        const cleaned = cleanProse(text);
        if (cleaned) parts.push(`${assistantName}: ${cleaned}`);
      };

      if (role === 'user') {
        // User content is either a plain string (typed prompt) or an array of
        // blocks — most commonly a single tool_result echoing back to the
        // assistant. JSON.stringify-ing the array bleeds tool_use_id /
        // type / is_error metadata into the searchable corpus; iterate blocks
        // instead so storage matches the assistant branch's signal density.
        if (typeof content === 'string') {
          emitUser(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'text') {
              const text = (b as { text?: string }).text;
              if (text) emitUser(text);
            } else if (b.type === 'tool_result') {
              const formatted = formatToolResult((b as { content?: unknown }).content);
              if (formatted) parts.push(formatted);
            }
            // tool_use_id / is_error / unknown block types: dropped silently.
          }
        }
      } else if (role === 'assistant') {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as Record<string, unknown>;

            if (b.type === 'text') {
              const text = (b as { text?: string }).text;
              if (text) emitAssistant(text);
            } else if (b.type === 'tool_use') {
              const name = (b as { name?: string }).name;
              parts.push(`[tool: ${name ?? '?'}]`);
            } else if (b.type === 'tool_result') {
              const formatted = formatToolResult((b as { content?: unknown }).content);
              if (formatted) parts.push(formatted);
            }
            // 'thinking' blocks intentionally fall through — internal
            // reasoning is not persisted (covered by hygiene tests).
          }
        } else if (typeof content === 'string') {
          emitAssistant(content);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return parts.join('\n');
}

/**
 * Converts JSONL transcript to natural language format.
 * Each line becomes "User: ..." or "Claude: ..." without JSON overhead.
 */
export function toNaturalLanguage(jsonl: string): string {
  if (!jsonl) return '';

  // Pass-through if not actually JSONL. Snapshots persist transcripts in
  // stage-play form ("alice: …", "Claude: …"); only the raw transcripts
  // pulled straight from ~/.claude/projects/**/*.jsonl need parsing.
  const firstLine = jsonl.split('\n')[0]?.trim() ?? '';
  if (!firstLine.startsWith('{')) {
    return jsonl;
  }

  // Otherwise parse as JSONL
  const lines = jsonl.split('\n').filter(l => l.trim());
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as JsonLine;
      const content = obj.message?.content ?? obj.content ?? '';
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      if (obj.type === 'user' || obj.message?.role === 'user') {
        parts.push(`User: ${contentStr}`);
      } else if (obj.type === 'assistant' || obj.message?.role === 'assistant') {
        parts.push(`Claude: ${contentStr}`);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return parts.join('\n');
}

interface AssistantLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Reads the transcript JSONL and returns the text of the most recent
 * assistant text message (skipping tool_use-only turns). Returns null
 * if unavailable.
 */
export async function readLastAssistantText(transcriptPath: string): Promise<string | null> {
  let lines: unknown[];
  try {
    lines = await readJsonlLines(transcriptPath);
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as AssistantLine;
    if (line?.type !== 'assistant') continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;

    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
        const text = (block as { text?: string }).text;
        if (typeof text === 'string' && text.trim()) textParts.push(text);
      }
    }
    if (textParts.length > 0) return textParts.join('\n').trim();
  }
  return null;
}

/**
 * Detects whether the assistant's last message was a question the user is
 * likely answering. Signals:
 *   - ends with ?
 *   - contains numbered options near the end (1. ... 2. ...)
 *   - last line starts with a question phrasing ("which", "what", "should I", etc.)
 */
export function looksLikeQuestion(assistantText: string | null): boolean {
  if (!assistantText) return false;
  const trimmed = assistantText.trim();
  if (!trimmed) return false;

  // Grab the tail — the last ~400 chars are the relevant bit for end-of-turn intent
  const tail = trimmed.slice(-400).toLowerCase();

  if (tail.endsWith('?')) return true;

  // Numbered-list question: look for "\n1." and "\n2." in the tail
  if (/\n\s*1\.\s+\S/.test(tail) && /\n\s*2\.\s+\S/.test(tail)) return true;

  // Question-phrasing in the last couple of lines
  const lastLines = trimmed.split('\n').slice(-4).join(' ').toLowerCase();
  const questionStarters = [
    'which ', 'what ', 'should i ', 'should we ', 'shall i ', 'shall we ',
    'do you ', 'would you ', 'want me to ', 'want me to?', 'can you clarify',
    'how do you want', 'how would you like', 'is that ', 'are you ',
  ];
  if (questionStarters.some(p => lastLines.includes(p))) {
    // Require a ? or numbered options somewhere in the tail to avoid false positives
    if (tail.includes('?') || /\b1\.\s+\S/.test(tail)) return true;
  }

  return false;
}

/**
 * Heuristic: the user's reply looks like an answer to a question, not a
 * new topic. Applied only when the assistant just asked a question.
 *
 * Answer-shaped prompts tend to be short, pick a number/option, or start
 * with a confirmation/negation.
 */
export function looksLikeAnswer(prompt: string): boolean {
  const lower = prompt.trim().toLowerCase();
  if (lower.length === 0) return false;

  // Tiny prompts are almost always answers ("1", "yes", "the second one")
  if (lower.length <= 15) return true;

  // Starts with confirmation / negation / picking an option
  const answerStarters = [
    /^(y|yes|yeah|yep|yup|sure|ok|okay|right|correct|agreed|exactly|fine)\b/,
    /^(n|no|nope|nah|don'?t|not quite|not really)\b/,
    /^(option\s+)?[1-9]\b/,
    /^(the\s+)?(first|second|third|last|former|latter)\b/,
    /^(go|let'?s|do)\s+(with|for|ahead)\b/,
  ];
  if (answerStarters.some(re => re.test(lower))) return true;

  return false;
}
