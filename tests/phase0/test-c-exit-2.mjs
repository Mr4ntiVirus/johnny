#!/usr/bin/env node
// Phase 0 Test C — does exit code 2 block the prompt and surface stderr to the user?
//
// HOW TO RUN:
//   1. Install this as a UserPromptSubmit hook (see tests/phase0/install.mjs)
//   2. Start a new claude session
//   3. Type any prompt (e.g. "hello")
//   4. PASS: Prompt is blocked. You see the stderr message below in the terminal.
//   5. FAIL: Prompt goes through to Claude as normal (exit 2 not respected).
//
// After verifying pass/fail, uninstall the hook (tests/phase0/install.mjs --uninstall)
// because this hook blocks ALL prompts.

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

if (process.env.JOHNNY_BYPASS || existsSync(path.join(os.homedir(), '.johnny', 'disabled'))) {
  process.stdout.write('{}');
  process.exit(0);
}

const LOG = path.join(os.homedir(), '.johnny', 'phase0-c.log');

let input = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) input += chunk;

await fs.mkdir(path.dirname(LOG), { recursive: true });
await fs.appendFile(LOG, `${new Date().toISOString()} hook fired — blocking prompt\n`);

process.stderr.write(
  '?‼ PHASE0C_TEST: prompt blocked by exit-2 hook. ' +
  'If you can read this in the terminal, exit-2 + stderr is working.\n'
);
process.exit(2);
