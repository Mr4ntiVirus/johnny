// Ollama HTTP client. Set JOHNNY_LLM_MOCK=1 to return deterministic stub responses
// without Ollama running — used in tests and when Ollama is offline.

const OLLAMA_BASE = process.env.JOHNNY_OLLAMA_URL ?? 'http://localhost:11434';
const EMBED_MODEL = process.env.JOHNNY_EMBED_MODEL ?? 'mxbai-embed-large';
const CLASSIFY_MODEL = process.env.JOHNNY_CLASSIFY_MODEL ?? 'qwen2.5:3b';
// Default budget for calls on the interactive hook path (evaluate.ts, via
// runClassifier). The background model-warmer (no user-facing deadline) passes the
// longer WARM_TIMEOUT_MS so a cold-start model load can finish instead of aborting.
const TIMEOUT_MS = 5_000;
export const WARM_TIMEOUT_MS = 25_000;

export const MOCK_MODE = !!process.env.JOHNNY_LLM_MOCK;

// Exposed so embedded data can pin the model name. Cosine scores are only
// directly comparable within the same model generation; consumers store this
// alongside the vector and refuse cross-model comparisons.
export function getEmbedModelName(): string {
  return MOCK_MODE ? 'mock' : EMBED_MODEL;
}

async function ollamaPost(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${path} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Latency ring buffers (last 20 calls each). Resets on process restart —
// transient signal for the observability dashboard.
const LATENCY_BUFFER_SIZE = 20;
const embedLatencies: number[] = [];
const classifyLatencies: number[] = [];

function recordLatency(buf: number[], ms: number): void {
  buf.push(ms);
  if (buf.length > LATENCY_BUFFER_SIZE) buf.shift();
}

function avg(buf: number[]): number {
  if (buf.length === 0) return 0;
  return Math.round(buf.reduce((a, b) => a + b, 0) / buf.length);
}

export interface OllamaLatency {
  embed: number;        // avg ms over last N embed calls
  classify: number;     // avg ms over last N classify calls
  embedSamples: number;
  classifySamples: number;
}

export function getOllamaLatency(): OllamaLatency {
  return {
    embed: avg(embedLatencies),
    classify: avg(classifyLatencies),
    embedSamples: embedLatencies.length,
    classifySamples: classifyLatencies.length,
  };
}

const EMBED_MAX_CHARS = 2000;

// Returns a unit vector (already normalized by Ollama).
export async function embed(text: string, timeoutMs?: number): Promise<number[]> {
  if (MOCK_MODE) return mockEmbedding(text);
  const t0 = Date.now();
  // The embed model's context is 512 tokens; longer input (a pasted email, URL-dense text) makes
  // Ollama answer 500 "input length exceeds the context length" in ~20ms. Retry on a shorter
  // prefix rather than failing the caller (priming used to log these as `failed`).
  let input = text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ollamaPost('/api/embeddings', { model: EMBED_MODEL, prompt: input, keep_alive: -1 }, timeoutMs) as { embedding: number[] };
      recordLatency(embedLatencies, Date.now() - t0);
      return res.embedding;
    } catch (err) {
      if (attempt >= 3 || input.length <= 200 || !/→ 500/.test(String(err))) throw err;
      input = input.slice(0, Math.floor(input.length / 2));
    }
  }
}

// Returns one of: 'continuation' | 'topic_switch' | 'new_topic' | 'ambiguous'
export async function classify(prompt: string, contextSummary: string, timeoutMs?: number): Promise<string> {
  if (MOCK_MODE) return 'continuation';

  const systemPrompt = [
    'You are an intent classifier for an AI coding session manager.',
    'Given a user prompt and a summary of the current session context,',
    'classify the intent as exactly one of:',
    '  continuation  — the prompt continues the current work',
    '  topic_switch  — the prompt is about a different topic that may have prior context',
    '  new_topic     — the prompt is about a new topic with no prior context',
    '  ambiguous     — cannot determine with confidence',
    'Reply with only the intent label. No explanation.',
  ].join('\n');

  const userMessage = `Context: ${contextSummary.slice(0, 400)}\n\nPrompt: ${prompt.slice(0, 300)}`;

  const res = await ollamaPost('/api/generate', {
    model: CLASSIFY_MODEL,
    system: systemPrompt,
    prompt: userMessage,
    stream: false,
    keep_alive: -1,
    options: { temperature: 0, num_predict: 10 },
  }, timeoutMs) as { response: string };

  return parseClassifyLabel(res.response);
}

const VALID_LABELS = ['continuation', 'topic_switch', 'new_topic', 'ambiguous'] as const;

export function parseClassifyLabel(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if ((VALID_LABELS as readonly string[]).includes(trimmed)) return trimmed;

  // Strip punctuation/whitespace noise (e.g. "new_topic.", "  continuation\n")
  const cleaned = trimmed.replace(/[^a-z_]/g, '');
  if ((VALID_LABELS as readonly string[]).includes(cleaned)) return cleaned;

  // Substring containment — none of the 4 labels is a substring of another.
  const found = VALID_LABELS.find(label => trimmed.includes(label));
  return found ?? 'ambiguous';
}

// Evaluates whether a turn was significant — praise/success or failure/damage.
// Reads BOTH the user's prompt and Claude's last response so it catches:
//   • User praising ("great job", "thank you")
//   • User reporting damage ("you deleted", "data loss")
//   • Claude announcing success ("recovered X", "restored Y")
//   • Claude reporting failure ("I made an error", "I apologize")
// Returns 'neutral' when Ollama is offline (graceful degradation).
// Deterministic keyword pre-filter for classifyOutcome.
// Runs before the LLM (and before MOCK_MODE) so tests can exercise it with JOHNNY_LLM_MOCK=1.
// Kept narrow — only unambiguous short-form user signals that the LLM reliably fumbles
// when paired with verbose assistant error-recovery text.
const OUTCOME_PRAISE_SIGNALS = ['it worked', 'that worked', 'it works', 'works now', 'working now'];
const OUTCOME_FAILURE_SIGNALS = ['data loss', 'you deleted my', 'you broke it', 'you broke my'];

export function classifyOutcomeFromKeywords(userPrompt: string): 'praise' | 'failure' | null {
  const lower = userPrompt.toLowerCase();
  if (OUTCOME_PRAISE_SIGNALS.some(s => lower.includes(s))) return 'praise';
  if (OUTCOME_FAILURE_SIGNALS.some(s => lower.includes(s))) return 'failure';
  return null;
}

export async function classifyOutcome(
  userPrompt: string,
  lastAssistantText: string,
): Promise<'praise' | 'failure' | 'neutral'> {
  // Fast path: clear user-signal keywords override the LLM. Runs before MOCK_MODE so
  // it is testable. The LLM can misread these when the assistant's prior text is
  // failure-flavored (e.g. "it worked" after a long debugging session).
  const keyword = classifyOutcomeFromKeywords(userPrompt);
  if (keyword) return keyword;

  if (MOCK_MODE) return 'neutral';

  const systemPrompt = [
    'You are an outcome classifier for an AI memory system.',
    'Given a user message and the AI assistant\'s last response,',
    'classify the overall outcome as exactly one of:',
    '  praise   — the user is expressing satisfaction, thanks, or approval; OR the assistant reports successful completion of something meaningful',
    '  failure  — the user reports a problem, data loss, error, or damage; OR the assistant acknowledges a mistake or apologizes for harm done',
    '  neutral  — routine work, neither significant praise nor failure',
    'IMPORTANT: The user\'s message is the primary signal. If the user clearly expresses satisfaction or success, classify as praise even if the assistant\'s text discussed errors or problems.',
    'Reply with only the label. No explanation.',
  ].join('\n');

  const userMessage = [
    `User: ${userPrompt.slice(0, 300)}`,
    `Assistant (last turn): ${lastAssistantText.slice(0, 400)}`,
  ].join('\n\n');

  try {
    const t0 = Date.now();
    const res = await ollamaPost('/api/generate', {
      model: CLASSIFY_MODEL,
      system: systemPrompt,
      prompt: userMessage,
      stream: false,
      keep_alive: -1,
      options: { temperature: 0, num_predict: 5 },
    }) as { response: string };
    recordLatency(classifyLatencies, Date.now() - t0);
    const label = res.response.trim().toLowerCase();
    if (label === 'praise' || label === 'failure') return label;
    return 'neutral';
  } catch {
    return 'neutral';
  }
}

export async function isOllamaOnline(): Promise<boolean> {
  if (MOCK_MODE) return false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  }
}

// Deterministic mock embedding: hash text into a unit vector.
// Two semantically different strings will have different hashes (imperfect but testable).
function mockEmbedding(text: string): number[] {
  const dim = 64;
  const vec = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dim] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}
