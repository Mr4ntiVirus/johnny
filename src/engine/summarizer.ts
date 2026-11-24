// Derives a human-readable summary and slug from a Claude session JSONL.
// Enhanced to generate human-friendly titles instead of keyword slugs.
import * as fs from 'node:fs/promises';
import { readJsonlLines } from '../utils/jsonl.js';
import { MOCK_MODE, isOllamaOnline } from '../utils/llm.js';

const OLLAMA_BASE = process.env.JOHNNY_OLLAMA_URL ?? 'http://localhost:11434';
const CLASSIFY_MODEL = process.env.JOHNNY_CLASSIFY_MODEL ?? 'qwen2.5:3b';
const TIMEOUT_MS = 12_000;

export interface SessionSummary {
  summary: string;
  slug: string;
  title: string;
}

function extractUserMessages(lines: unknown[]): string[] {
  const msgs: string[] = [];
  for (const line of lines) {
    const l = line as any;
    // Handle JSONL format
    if (l.type === 'user' || l.message?.role === 'user') {
      const content = l.message?.content ?? l.content;
      if (typeof content === 'string') {
        msgs.push(content.trim());
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            msgs.push(part.text.trim());
          }
        }
      }
    }
    // Handle natural language format: "User: ..."
    else if (typeof line === 'string' && line.startsWith('User:')) {
      msgs.push(line.slice(5).trim());
    }
  }
  return msgs.filter(m => m.length > 0);
}

function extractAssistantMessages(lines: unknown[]): string[] {
  const msgs: string[] = [];
  for (const line of lines) {
    const l = line as any;
    // Handle JSONL format
    if (l.type === 'assistant' || l.message?.role === 'assistant') {
      const content = l.message?.content ?? l.content;
      if (typeof content === 'string') {
        const short = content.slice(0, 300);
        if (short) msgs.push(short);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            msgs.push(part.text.slice(0, 300));
          }
        }
      }
    }
    // Handle natural language: "Claude: ..."
    else if (typeof line === 'string' && line.startsWith('Claude:')) {
      msgs.push(line.slice(7).trim());
    }
  }
  return msgs.filter(m => m.length > 0);
}

function keywordSlug(messages: string[]): string {
  const stopwords = new Set([
    'the','a','an','is','it','to','of','in','and','or','for','on','at','with',
    'this','that','be','was','are','have','i','you','we','they','do','not','can',
    'my','me','your','let','just','its','also','from','but','what','how','when','would',
    'could','should','want','need','make','get','use','using','want','like','look',
    'going','got','make','help','try','find','set','check','add','remove','update',
    'create','implement','make','fix','debug','test','write','read','edit','create'
  ]);
  const freq: Record<string, number> = {};
  for (const msg of messages) {
    for (const word of msg.toLowerCase().split(/\W+/)) {
      if (word.length > 3 && !stopwords.has(word)) {
        freq[word] = (freq[word] ?? 0) + 1;
      }
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)
    .join('-') || 'session';
}

async function ollamaGenerate(prompt: string, system: string, maxTokens = 80): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      prompt,
      system,
      stream: false,
      options: { temperature: 0.2, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  return ((await res.json()) as { response: string }).response.trim();
}

function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
}

function dateTag(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${mm}${dd}-${hh}${mi}`;
}

export async function titleFromSummary(summary: string): Promise<string> {
  const t = (await ollamaGenerate(
    `Summary of a coding session: "${summary.slice(0, 200)}"\n\nWrite a 4-9 word title naming the same specific subject. Respond with ONLY the title.`,
    'You write short, specific, human-readable titles.',
    40,
  )).trim().replace(/^["'`]+|["'`.]+$/g, '');
  return t.split(/\s+/).length >= 3 ? t.slice(0, 80) : '';
}

async function generateHumanTitle(userMessages: string[], assistantMessages: string[]): Promise<string> {
  const userSample = userMessages.slice(0, 5).join('\n').slice(0, 800);
  const assistantSample = assistantMessages.slice(-3).join('\n').slice(0, 500);

  const prompt = `User was working on a coding task with Claude. Based on these messages:

USER: ${userSample}

CLAUDE: ${assistantSample}

Generate a descriptive title (4-10 words) that clearly explains what happened in this session. Examples:
- "Fixed authentication flow bug in WebUI component"
- "Troubleshooting persistent database connection timeout issues"
- "Adding new API endpoints for user profile data"
- "Refactoring CLI error handling with better user feedback"
- "Setting up Docker compose for local development environment"

Respond with ONLY the title, nothing else.`;

  const system = 'You are a helpful coding assistant that creates clear, human-readable session titles.';
  return ollamaGenerate(prompt, system, 50);
}

// `opts.rawContent` lets callers summarise just the snapshot delta instead of
// the whole session file (whole-file summaries made 287 memories share one
// summary string and blinded summary-embedding recall).
export async function summarizeSession(
  transcriptPath: string,
  opts: { rawContent?: string } = {},
): Promise<SessionSummary> {
  let rawContent: string;
  if (opts.rawContent !== undefined) {
    rawContent = opts.rawContent;
  } else {
    try {
      rawContent = await fs.readFile(transcriptPath, 'utf-8');
    } catch {
      return { summary: 'empty session', slug: `session-${dateTag()}`, title: 'Empty coding session' };
    }
  }

  const isJsonL = rawContent.includes('{"type":') || rawContent.includes('"type":"');
  let lines: unknown[] = [];

  if (isJsonL) {
    // JSONL format - parse each line
    lines = rawContent.split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
  } else {
    // Natural language format - split by User:/Claude: lines
    lines = rawContent.split('\n').filter((l: string) => l.trim()).map((l: string) => {
      if (l.startsWith('User:') || l.startsWith('Claude:')) {
        return { type: l.startsWith('User:') ? 'user' : 'assistant', message: { role: l.startsWith('User:') ? 'user' : 'assistant', content: l.slice(l.indexOf(':') + 1).trim() } };
      }
      return null;
    }).filter(Boolean);
  }

  const realUserMessages = extractUserMessages(lines);
  const assistantMessages = extractAssistantMessages(lines);

  // A snapshot DELTA can be a long autonomous stretch with no user message in it. Summarise
  // from what the assistant said then, rather than calling real work an "empty session".
  const userMessages = realUserMessages.length > 0 ? realUserMessages : assistantMessages;
  if (userMessages.length === 0) {
    return {
      summary: 'empty session',
      slug: `session-${dateTag()}`,
      title: 'Empty coding session'
    };
  }

  const sample = userMessages.length <= 10
    ? userMessages
    : [...userMessages.slice(0, 2), ...userMessages.slice(-8)];
  const text = sample.join('\n').slice(0, 1500);

  // Use keyword fallback only if explicitly mocked OR Ollama is offline
  const ollamaUp = !MOCK_MODE && await isOllamaOnline();

  if (!ollamaUp) {
    const slug = keywordSlug(userMessages);
    console.log(`[summarizer] Ollama offline, using keyword fallback: ${slug}`);
    return {
      summary: `worked on: ${slug.replace(/-/g, ', ')}`,
      slug,
      title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    };
  }

  try {
    const summaryPrompt = `Coding session messages:\n${text.slice(0, 1200)}\n\nWrite ONE sentence (under 150 chars) naming the SPECIFIC thing worked on (the system, file, feature or topic) and what was done to it. Be concrete: a reader should be able to tell this session apart from a hundred others. Do not write generic summaries like "Implemented UI improvements and resolved backend issues". Start with a verb.`;
    const summary = await ollamaGenerate(
      summaryPrompt,
      'You are a terse technical writer. One sentence, action-focused, no filler.'
    );

    // Title is derived FROM the summary so the two cannot describe different things (they used to be two
    // independent generations: a memory titled "identifying system failures" had a wireframe-image summary).
    const title = await titleFromSummary(summary).catch(() => '') || await generateHumanTitle(userMessages, assistantMessages);
    const slug = titleToSlug(title);

    return {
      summary: summary.slice(0, 200),
      slug: `${slug}-${dateTag()}`,
      title,
    };
  } catch {
    const slug = keywordSlug(userMessages);
    return {
      summary: `worked on ${slug.replace(/-/g, ', ')}`,
      slug: `${slug}-${dateTag()}`,
      title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    };
  }
}



