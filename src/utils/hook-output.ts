// Hook stdout serialization.
//
// Claude Code (verified empirically against 2.1.296, 2026-10-12) only injects hook
// context from `hookSpecificOutput.additionalContext` (or plain stdout). A
// top-level `additionalContext` key — which Johnny emitted for months — is
// silently ignored, so every offer / recommend / bootstrap / nudge hint was being
// dropped. Internally Johnny still passes `HookOutput.additionalContext` around;
// this converts it to the documented shape at the single point where stdout is written.

import type { HookOutput } from '../types.js';

export function serializeHookOutput(
  output: HookOutput,
  event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' = 'UserPromptSubmit',
  opts: { legacyHints?: boolean } = {},
): string {
  const { additionalContext, knowledgeContext, ...rest } = output;
  const out: Record<string, unknown> = { ...rest };
  // Compiled-knowledge priming always flows; the older hint channel only when opted in.
  const parts = [knowledgeContext, opts.legacyHints === false ? undefined : additionalContext]
    .filter((p): p is string => !!p && !!p.trim());
  if (parts.length > 0) {
    out.hookSpecificOutput = { hookEventName: event, additionalContext: parts.join('\n\n---\n\n') };
  }
  return JSON.stringify(out);
}
