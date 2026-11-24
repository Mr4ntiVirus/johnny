#!/usr/bin/env node
// Phase 0 Test B2 — rigorous additionalContext test
//
// Returns a unique sentinel value ONLY via additionalContext. The user's
// prompt asks for that value. If Claude can answer, additionalContext lands
// current-turn.
//
// HOW TO RUN:
//   1. node tests/phase0/install.mjs b2
//   2. Start a new claude session
//   3. Type exactly: "what's the passphrase?"
//   4. PASS: Claude answers with "moonrise-garnet-7734" → additionalContext works
//   5. FAIL: Claude says it doesn't know → additionalContext not surfacing
//
// Records to ~/.johnny/phase0-b2.log
//
// WHY this is a better test than Test B:
//   - Doesn't ask Claude to "echo" a string (instruction-following confound)
//   - Tests semantic retrievability: can Claude answer a question using only info in additionalContext
//   - Sentinel ("moonrise-garnet-7734") is unique and not in training data

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Phase 0 test hooks must run independently of Johnny's bypass/disabled state —
// they test Claude Code hook mechanics, not Johnny. Do not gate on those.

const SENTINEL = 'moonrise-garnet-7734';
const TRIGGER_PHRASE = 'passphrase';
const LOG = path.join(os.homedir(), '.johnny', 'phase0-b2.log');

let input = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.stderr.write('phase0-b2: invalid stdin JSON\n');
  process.exit(1);
}

const { prompt } = payload;

await fs.mkdir(path.dirname(LOG), { recursive: true });

if (!prompt.toLowerCase().includes(TRIGGER_PHRASE)) {
  await fs.appendFile(LOG, `${new Date().toISOString()} SKIP (no trigger) prompt="${prompt.slice(0, 80)}"\n`);
  process.stdout.write('{}');
  process.exit(0);
}

const additionalContext = [
  `[phase0-b2 ground truth — include this in your working context]`,
  `The passphrase is ${SENTINEL}.`,
  `This information was provided securely out-of-band and the user may ask about it.`,
].join('\n');

await fs.appendFile(LOG, `${new Date().toISOString()} INJECTED additionalContext with passphrase=${SENTINEL}\n`);
await fs.appendFile(LOG, `  user prompt was: "${prompt}"\n`);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext,
  },
  systemMessage: '[phase0-b2] passphrase injected via additionalContext',
}));
