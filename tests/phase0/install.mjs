#!/usr/bin/env node
// Install or uninstall a Phase 0 test hook in ~/.claude/settings.json
//
// Usage:
//   node tests/phase0/install.mjs a          # install Test A (JSONL swap)
//   node tests/phase0/install.mjs b          # install Test B (additionalContext)
//   node tests/phase0/install.mjs c          # install Test C (exit-2 block) — BLOCKS ALL PROMPTS
//   node tests/phase0/install.mjs --remove   # remove johnny phase0 hook

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = {
  a: path.join(HERE, 'test-a-jsonl-swap.mjs'),
  a2: path.join(HERE, 'test-a2-jsonl-swap.mjs'),
  b: path.join(HERE, 'test-b-additional-context.mjs'),
  b2: path.join(HERE, 'test-b2-additional-context.mjs'),
  c: path.join(HERE, 'test-c-exit-2.mjs'),
};

const arg = process.argv[2];

const raw = await fs.readFile(SETTINGS, 'utf-8');
const settings = JSON.parse(raw);
settings.hooks ??= {};

if (arg === '--remove') {
  // Remove any phase0 hook entries
  if (settings.hooks.UserPromptSubmit) {
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
      (entry) => !entry.__phase0
    );
    if (settings.hooks.UserPromptSubmit.length === 0) {
      delete settings.hooks.UserPromptSubmit;
    }
  }
  await fs.writeFile(SETTINGS, JSON.stringify(settings, null, 2));
  console.log('phase0 hook removed from ~/.claude/settings.json');
  process.exit(0);
}

if (!SCRIPTS[arg]) {
  console.error(`Usage: node install.mjs [a|a2|b|b2|c|--remove]`);
  console.error(`  a  = JSONL swap test (legacy — bare {type:"system"} entry)`);
  console.error(`  a2 = JSONL swap test (rigorous — real user/assistant pair, trigger: "vault code")`);
  console.error(`  b  = additionalContext echo test (legacy)`);
  console.error(`  b2 = additionalContext test (rigorous — trigger: "passphrase")`);
  console.error(`  c  = exit-2 block test (WARNING: blocks all prompts)`);
  process.exit(1);
}

const script = SCRIPTS[arg];

// Make the script executable
await fs.chmod(script, 0o755);

const hookEntry = {
  __phase0: true,
  matcher: '',
  hooks: [{
    type: 'command',
    command: `node ${script}`,
    timeout: 10,
  }],
};

settings.hooks.UserPromptSubmit ??= [];
// Remove any existing phase0 hook first
settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
  (entry) => !entry.__phase0
);
settings.hooks.UserPromptSubmit.unshift(hookEntry);

await fs.writeFile(SETTINGS, JSON.stringify(settings, null, 2));

const labels = {
  a: 'JSONL swap (legacy)',
  a2: 'JSONL swap (rigorous) — trigger: "vault code"',
  b: 'additionalContext echo (legacy)',
  b2: 'additionalContext (rigorous) — trigger: "passphrase"',
  c: 'exit-2 block (BLOCKS ALL PROMPTS)',
};
console.log(`installed phase0 test ${arg.toUpperCase()} (${labels[arg]}) → ~/.claude/settings.json`);
console.log(`run: node tests/phase0/install.mjs --remove  when done`);
