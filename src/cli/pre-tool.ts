// PreToolUse hook — mid-turn priming for shell commands.
//
// UserPromptSubmit cannot fire mid-turn, so knowledge relevant only once Claude is
// running something (e.g. the "macOS has no `timeout`" convention, or the AWS
// default-profile rule) would otherwise never be primed after the first prompt.
// Claude Code supports hookSpecificOutput.additionalContext on PreToolUse.
//
// TIMING (verified against a real session, 2026-10-12): the context is attached
// alongside the tool RESULT — the model sees it after that first command ran but
// before its next step. So this prevents REPEATS of a mistake within the turn; it
// cannot stop the first failing call. Prompt-time priming (evaluate) is what
// covers a first call whose topic appears in the prompt.
//
// Same embedding-only matching, trust gates, once-per-context-epoch rule and flag as
// prompt-time priming. Budget: a hard ~1.5s embed deadline; slower just passes through.

import { recordPrimeEvent } from '../store/db/prime-events.js';
import { exitIfBypassed } from '../utils/bypass.js';
import { embed } from '../utils/llm.js';
import { readKnowledgeConfig } from '../knowledge/config.js';
import { computePrime } from '../knowledge/prime.js';
import { getSessionTurn } from '../store/db/sessions.js';
import { claimJob } from '../store/db/jobs.js';
import { log } from '../utils/log.js';
import type { KnowledgeConfig } from '../types.js';

export interface PreToolPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: unknown } & Record<string, unknown>;
}

const EMBED_DEADLINE_MS = 1500;
const MIN_COMMAND_CHARS = 24;
export const TOOL_SCAN_MIN_INTERVAL_MS = 60_000;
const TRIVIAL = /^\s*(ls|cd|pwd|echo|cat|head|tail|wc|which|true|false|clear|date|whoami|git\s+(status|log|diff|branch|show)|npm\s+(run\s+)?(test|build|typecheck)|pytest|vitest)\b/;

/** Cheap pre-filter: only commands that can carry environment conventions are worth an embedding. */
export function shouldConsiderCommand(command: string): boolean {
  const c = command.trim();
  if (c.length < MIN_COMMAND_CHARS) return false;
  if (TRIVIAL.test(c) && c.length < 80) return false;
  return true;
}

export async function preToolHook(
  payload: PreToolPayload, cfgOverride?: KnowledgeConfig,
): Promise<Record<string, unknown>> {
  if (payload.tool_name !== 'Bash') return {};
  const command = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
  if (!command || !shouldConsiderCommand(command) || !payload.session_id) return {};

  const cfg = cfgOverride ?? await readKnowledgeConfig();
  if (!cfg.prime) return {};

  // This hook runs on EVERY shell command: scan at most once per minute per session
  // (an atomic claim whose TTL is the rate limit; never released on purpose).
  if (!(await claimJob('tool-prime', payload.session_id, 'pre-tool', TOOL_SCAN_MIN_INTERVAL_MS))) return {};

  const embedding = await Promise.race<number[] | null>([
    embed(command).catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), EMBED_DEADLINE_MS)),
  ]);
  if (!embedding) return {};

  const turn = await getSessionTurn(payload.session_id).catch(() => 0);
  const prime = await computePrime({
    promptEmbedding: embedding, promptText: command, cwd: payload.cwd ?? process.cwd(),
    sessionId: payload.session_id, turn, trigger: 'tool', config: cfg,
  });
  if (!prime) return {};
  await log(`pre-tool prime: ${prime.refs.join(', ')} · sim=${prime.topScore.toFixed(3)}`);
  await recordPrimeEvent({ sessionId: payload.session_id, trigger: 'tool', outcome: 'primed', refs: prime.refs as unknown as string[], topScore: prime.topScore });
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: prime.additionalContext } };
}

export async function runPreTool(): Promise<void> {
  exitIfBypassed();
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;
  let payload: PreToolPayload = {};
  try { payload = JSON.parse(input); } catch { /* pass through */ }
  let out: Record<string, unknown> = {};
  try { out = await preToolHook(payload); } catch (err) { await log(`pre-tool failed (ignored): ${err}`); }
  // Flush then exit: Ollama's keep-alive socket would otherwise hold the process open past the hook timeout.
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}
