#!/usr/bin/env node
// Phase 0 Test B — is additionalContext visible to the user via Claude's response?
//
// HOW TO RUN:
//   1. Install this as a UserPromptSubmit hook (see tests/phase0/install.mjs)
//   2. Start a new claude session
//   3. Type any prompt (e.g. "hello")
//   4. PASS: Claude's response includes "PHASE0B_CONFIRMED"
//   5. FAIL: No mention — additionalContext is consumed silently.
//            Activate stderr fallback (see JOHNNY_SPEC.md §Stderr fallback design).
//
// Records result to ~/.johnny/phase0-b.log

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.JOHNNY_BYPASS || existsSync(path.join(os.homedir(), '.johnny', 'disabled'))) {
  process.stdout.write('{}');
  process.exit(0);
}

const LOG = path.join(os.homedir(), '.johnny', 'phase0-b.log');

let input = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) input += chunk;

await fs.mkdir(path.dirname(LOG), { recursive: true });
await fs.appendFile(LOG, `${new Date().toISOString()} hook fired\n`);

// Return a distinctive additionalContext that asks Claude to confirm it's visible
const additionalContext = [
  '[PHASE0B_TEST] This text was injected via additionalContext from a UserPromptSubmit hook.',
  'If you can read this, include the exact text "PHASE0B_CONFIRMED" anywhere in your response.',
].join(' ');

process.stdout.write(JSON.stringify({ additionalContext }));
