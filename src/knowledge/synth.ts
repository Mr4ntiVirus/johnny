// Synthesizer — the pluggable "LLM as a pure function" behind all knowledge
// synthesis (fact extraction, consolidation, model refresh, verification).
//
// ClaudeCliSynthesizer is the production backend: `claude -p` under the user's
// subscription OAuth login, with ALL tools disabled (`--tools ""`), restricted
// mode (no settings files, no code-running tools), no MCP servers and no
// session persistence. It is a text-in/text-out function — packets contain
// untrusted memory text (ingested emails, fetched pages, tool output) and a
// tool-less model cannot act on embedded instructions. A clean environment is
// required: inheriting CLAUDE_CODE_* vars from a parent Claude session makes
// the CLI refuse restricted mode ("bypassPermissions not supported").

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SynthRole = 'extract' | 'consolidate' | 'model' | 'verify' | 'name';

export interface SynthRequest {
  role: SynthRole;
  system?: string;
  prompt: string;
  /** Soft cap used only for usage accounting. */
  maxOutputTokens?: number;
}

export interface SynthResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Synthesizer {
  readonly name: string;
  complete(req: SynthRequest): Promise<SynthResponse>;
}

export class SynthRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterMs: number = 30 * 60_000) {
    super(message);
    this.name = 'SynthRateLimitError';
  }
}

/**
 * The Claude login was unavailable (seen live: a ~10 minute "Not logged in" window).
 * Treated like a rate limit — stop, back off, retry on a later heartbeat — and
 * never as a content failure, so a login hiccup can't pause a pipeline step.
 */
export class SynthAuthError extends SynthRateLimitError {
  constructor(message: string) { super(message, 20 * 60_000); this.name = 'SynthAuthError'; }
}

export class SynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthError';
  }
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

// ── Claude CLI backend ───────────────────────────────────────────────────────

export interface ClaudeCliOptions {
  binary?: string;
  /** Per-call timeout override; defaults are role-based (see ROLE_TIMEOUT_MS). */
  /** Model alias per role; falls back to `defaultModel`. */
  models?: Partial<Record<SynthRole, string>>;
  defaultModel?: string;
  timeoutMs?: number;
}

// Calls normally take 10-60s. A call that hangs (seen live: stalled for the full
// 10 minutes, three times in one pass) is killed early and retried once.
const ROLE_TIMEOUT_MS: Record<SynthRole, number> = {
  extract: 4 * 60_000, verify: 3 * 60_000, name: 3 * 60_000,
  consolidate: 8 * 60_000, model: 8 * 60_000,
};

const AUTH_RE = /(not logged in|please run \/login|invalid (api key|credentials)|authentication (failed|error)|oauth token)/i;
const RATE_LIMIT_RE = /(session limit|hit your .{0,20}limit|resets \d|usage limit|rate limit|rate_limit|too many requests|\b429\b|overloaded|quota|limit reached)/i;

/** Env passed to the child: minimal and clean (no inherited CLAUDE_CODE_* vars). */
export function cleanSynthEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  env.JOHNNY_BYPASS = '1';
  return env;
}

export function buildClaudeArgs(model: string, system?: string): string[] {
  const args = [
    '-p',
    '--tools', '',
    '--restricted',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'text',
    '--model', model,
  ];
  if (system) args.push('--append-system-prompt', system);
  return args;
}

export class ClaudeCliSynthesizer implements Synthesizer {
  readonly name = 'claude-cli';
  private readonly binary: string;

  constructor(private readonly opts: ClaudeCliOptions = {}) {
    this.binary = opts.binary ?? process.env.JOHNNY_CLAUDE_BIN ?? 'claude';
  }

  async complete(req: SynthRequest): Promise<SynthResponse> {
    try {
      return await this.completeOnce(req);
    } catch (err) {
      // One automatic retry for a hung/killed call; rate limits and other failures propagate.
      if (err instanceof SynthError && !(err instanceof SynthRateLimitError) && /timed out/.test(err.message)) {
        return this.completeOnce(req);
      }
      throw err;
    }
  }

  private async completeOnce(req: SynthRequest): Promise<SynthResponse> {
    const timeoutMs = this.opts.timeoutMs ?? ROLE_TIMEOUT_MS[req.role];
    const model = this.opts.models?.[req.role] ?? this.opts.defaultModel ?? 'sonnet';
    // Empty scratch cwd so no CLAUDE.md / project context is ever loaded.
    const cwd = path.join(os.tmpdir(), 'johnny-synth-cwd');
    fs.mkdirSync(cwd, { recursive: true });

    return new Promise<SynthResponse>((resolve, reject) => {
      const child = spawn(this.binary, buildClaudeArgs(model, req.system), {
        cwd,
        env: cleanSynthEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new SynthError(`claude timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.on('error', e => { clearTimeout(timer); reject(new SynthError(`spawn failed: ${e.message}`)); });
      child.on('close', code => {
        clearTimeout(timer);
        const text = out.trim();
        if (code !== 0 || !text) {
          const blob = `${err}\n${out}`;
          if (AUTH_RE.test(blob)) {
            reject(new SynthAuthError(`claude login unavailable: ${blob.slice(0, 160).trim()}`));
          } else if (RATE_LIMIT_RE.test(blob)) {
            reject(new SynthRateLimitError(`claude rate/usage limited: ${blob.slice(0, 200).trim()}`));
          } else {
            reject(new SynthError(`claude exited ${code}: ${blob.slice(0, 300).trim()}`));
          }
          return;
        }
        // Login/rate-limit messages can also arrive as a short "successful" text reply.
        if (text.length < 300 && AUTH_RE.test(text) && !text.includes('{')) {
          reject(new SynthAuthError(`claude login unavailable: ${text}`));
          return;
        }
        if (text.length < 300 && RATE_LIMIT_RE.test(text) && !text.includes('{')) {
          reject(new SynthRateLimitError(`claude rate/usage limited: ${text}`));
          return;
        }
        resolve({ text, inputTokens: estimateTokens(req.prompt + (req.system ?? '')), outputTokens: estimateTokens(text) });
      });

      child.stdin.on('error', () => { /* child died early; close handler reports it */ });
      child.stdin.end(req.prompt);
    });
  }
}

// ── Mock backend (tests, dry runs) ───────────────────────────────────────────

export type MockHandler = (req: SynthRequest, callIndex: number) => string | Promise<string>;

export class MockSynthesizer implements Synthesizer {
  readonly name = 'mock';
  public calls: SynthRequest[] = [];

  constructor(private readonly handler: MockHandler | string[]) {}

  async complete(req: SynthRequest): Promise<SynthResponse> {
    const i = this.calls.length;
    this.calls.push(req);
    let text: string;
    if (Array.isArray(this.handler)) {
      if (i >= this.handler.length) throw new SynthError(`MockSynthesizer: no scripted response for call ${i}`);
      text = this.handler[i];
    } else {
      text = await this.handler(req, i);
    }
    return { text, inputTokens: estimateTokens(req.prompt), outputTokens: estimateTokens(text) };
  }
}

// ── Response parsing helpers ─────────────────────────────────────────────────

/**
 * Best-effort repair of almost-valid JSON from a model: drops closing brackets
 * that don't match the open one (the common "}}" slip), removes trailing commas,
 * and closes anything left open (truncated output). Strings are respected.
 * Output still goes through strict schema/quote validation downstream.
 */
export function repairJson(src: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out.push(c);
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out.push(c); continue; }
    if (c === '{') { stack.push('}'); out.push(c); continue; }
    if (c === '[') { stack.push(']'); out.push(c); continue; }
    if (c === '}' || c === ']') {
      if (stack.length === 0) break;            // the object ended; ignore trailing garbage
      if (stack[stack.length - 1] !== c) continue; // mismatched closer: drop it
      // remove a trailing comma before the closer
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && out[j] === ',') out.splice(j, 1);
      stack.pop(); out.push(c);
      if (stack.length === 0) break;
      continue;
    }
    out.push(c);
  }
  if (inStr) out.push('"');
  while (out.length && /[\s,:]/.test(out[out.length - 1])) out.pop(); // dangling separator from truncation
  while (stack.length) out.push(stack.pop()!);
  return out.join('');
}

/** Extract the first top-level JSON object from free-form model output (strict, then repaired). */
export function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const src of candidates) {
    const start = src.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(src.slice(start, i + 1)); } catch { break; }
        }
      }
    }
    // Strict parse failed (or never balanced): attempt a bracket repair.
    try { return JSON.parse(repairJson(src.slice(start))); } catch { /* try next candidate */ }
  }
  return null;
}
