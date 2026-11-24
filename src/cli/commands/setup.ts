// First-run setup: create ~/.johnny/, handle full Ollama lifecycle, wire hooks, bootstrap.
import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { PATHS } from '../../store/paths.js';
import { DEFAULT_CONFIG } from '../../store/config.js';
import { isOllamaOnline } from '../../utils/llm.js';
import { writeJsonFile } from '../../utils/jsonl.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { printBanner } from '../../brand/banner.js';
import { cmdInstall } from './install.js';
import { cmdBootstrap } from './bootstrap.js';
import { printSysCheck } from '../../utils/syscheck.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMBED_MODEL    = process.env.JOHNNY_EMBED_MODEL    ?? 'mxbai-embed-large';
const CLASSIFY_MODEL = process.env.JOHNNY_CLASSIFY_MODEL ?? 'qwen2.5:3b';
const OLLAMA_BASE    = process.env.JOHNNY_OLLAMA_URL     ?? 'http://localhost:11434';

const w = (s: string) => process.stdout.write(s);

// `johnny setup --yes` answers yes to every prompt; without a TTY and without --yes the answer is no.
let ASSUME_YES = false;
async function confirm(question: string): Promise<boolean> {
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise(resolve => rl.question(`  ${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ── Ollama binary detection ───────────────────────────────────────────────────

function ollamaBinaryExists(): boolean {
  try {
    cp.execSync('which ollama', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function brewExists(): boolean {
  try {
    cp.execSync('which brew', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── Ollama installation ───────────────────────────────────────────────────────

async function installOllama(): Promise<boolean> {
  if (os.platform() !== 'darwin') {
    w(neon.amber('  ↯ Johnny supports macOS only; install Ollama yourself from https://ollama.com/download\n'));
    return false;
  }
  if (!brewExists()) {
    w(neon.amber('  ↯ Homebrew not found\n'));
    w(dim.fg('    install Ollama from https://ollama.com/download, then re-run: johnny setup\n'));
    return false;
  }
  if (!(await confirm('Install Ollama with Homebrew (brew install ollama)?'))) {
    w(dim.fg('  skipped · install Ollama yourself, then re-run: johnny setup\n'));
    return false;
  }
  w(dim.fg('  installing ollama via homebrew...\n'));
  try {
    cp.execSync('brew install ollama', { stdio: 'inherit' });
    w(neon.green('  ✓ ollama installed\n'));
    return true;
  } catch {
    w(neon.red('  × brew install failed\n'));
    return false;
  }
}

// ── Ollama server lifecycle ───────────────────────────────────────────────────

async function waitForOllama(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const SPIN = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
  let frame = 0;

  while (Date.now() < deadline) {
    w(`\r  ${neon.cyan(SPIN[frame++ % SPIN.length])} ${dim.fg('waiting for ollama server...')}\x1b[K`);
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
      if (res.ok) {
        w(`\r${neon.green('  ✓ ollama server ready')}          \n`);
        return true;
      }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }

  w(`\r${neon.red('  × ollama server did not start in time')}          \n`);
  return false;
}

async function startOllamaServer(): Promise<boolean> {
  w(dim.fg('  starting ollama server...\n'));
  try {
    // Detach so it outlives this process
    const child = cp.spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return await waitForOllama();
  } catch {
    w(neon.red('  × could not start ollama serve\n'));
    return false;
  }
}

// ── Model management ──────────────────────────────────────────────────────────

async function ollamaHasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return false;
    const body = await res.json() as { models?: Array<{ name: string }> };
    return (body.models ?? []).some(m => m.name === model || m.name.startsWith(model + ':'));
  } catch { return false; }
}

async function ollamaPull(model: string): Promise<boolean> {
  w(dim.fg(`  pulling ${model}`));

  // Stream progress so the user sees it moving
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) {
      w(neon.red(' failed\n'));
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastStatus = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number };
          if (obj.status && obj.status !== lastStatus) {
            lastStatus = obj.status;
            if (obj.completed !== undefined && obj.total && obj.total > 0) {
              const pct = Math.round((obj.completed / obj.total) * 100);
              w(`\r  ${dim.fg(`pulling ${model}`)} ${neon.cyan(`${pct}%`)}\x1b[K`);
            }
          }
        } catch { /* malformed line */ }
      }
    }

    w(`\r  ${neon.green(`✓ ${model} ready`)}                    \n`);
    return true;
  } catch {
    w(neon.red(' failed\n'));
    return false;
  }
}

// ── Full Ollama orchestration ─────────────────────────────────────────────────

async function ensureOllama(): Promise<boolean> {
  // Step 1: binary present?
  if (!ollamaBinaryExists()) {
    w(neon.amber('  ↯ ollama not installed · attempting install\n'));
    const installed = await installOllama();
    if (!installed) return false;
  } else {
    w(dim.fg('  ollama binary found\n'));
  }

  // Step 2: server running?
  const alreadyUp = await isOllamaOnline();
  if (!alreadyUp) {
    w(dim.fg('  server not running · starting ollama serve\n'));
    const started = await startOllamaServer();
    if (!started) return false;
  } else {
    w(neon.green('  ✓ ollama server online\n'));
  }

  // Step 3: models present?
  for (const model of [EMBED_MODEL, CLASSIFY_MODEL]) {
    const has = await ollamaHasModel(model);
    if (has) {
      w(dim.fg(`  ${model}: already pulled\n`));
    } else if (!(await confirm(`Download the ${model} model with Ollama (can be several GB)?`))) {
      w(neon.amber(`  ↯ ${model} skipped · run: ollama pull ${model}\n`));
    } else {
      const ok = await ollamaPull(model);
      if (!ok) {
        w(neon.amber(`  ↯ ${model} pull failed · johnny will fall back to heuristics\n`));
      }
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function cmdSetup(args: string[] = []): Promise<void> {
  ASSUME_YES = args.includes('--yes') || args.includes('-y');
  await printBanner();
  w(neon.cyan('◈ setting up\n\n'));

  // 0. System requirements check
  const sysResult = await printSysCheck();
  if (sysResult.hardFail) {
    process.exit(1);
  }

  // 1. Create ~/.johnny/ directory structure
  w(dim.fg('  creating ~/.johnny/ ...'));
  await fs.mkdir(PATHS.dir, { recursive: true });
  w(neon.green(' done\n'));

  // 2. Write default config if not present
  try {
    await fs.access(PATHS.config);
    w(dim.fg('  config: already exists\n'));
  } catch {
    await writeJsonFile(PATHS.config, DEFAULT_CONFIG);
    w(dim.fg('  config: defaults written\n'));
  }

  // 3. Full Ollama lifecycle
  w('\n');
  w(dim.fg('  ── ollama ─────────────────────────────\n'));
  await ensureOllama();

  // 4. Wire hooks
  w('\n');
  await cmdInstall();

  // 5. Bootstrap — ingest all existing Claude sessions
  w('\n');
  await cmdBootstrap(true);

  // 6. Automatic knowledge synthesis (facts, observations, mental models)
  w('\n');
  await offerAutoSynth();

  // Praxis: reconcile skill files — if DB was wiped, rebuild skill memory nodes
  // from any existing ~/.claude/skills/ files with johnny.sourceMemoryIds.
  await reconcileSkillFiles();

  w(neon.cyan('◈ ready.\n'));
  w(dim.fg('  start the daemon: johnny daemon start\n'));
  w(dim.fg('  check status:     johnny status\n'));
  w(dim.fg('  bypass anytime:   JOHNNY_BYPASS=1 claude\n'));
}

// ── automatic knowledge synthesis ─────────────────────────────────────────────

function claudeOnPath(): boolean {
  try { cp.execSync('command -v claude', { stdio: 'ignore' }); return true; } catch { return false; }
}

async function offerAutoSynth(): Promise<void> {
  w(dim.fg('  ── knowledge synthesis ────────────────\n'));
  if (!claudeOnPath()) {
    w(neon.amber('  ↯ `claude` not found · skipping automatic synthesis\n'));
    w(dim.fg('    install Claude Code, then run: johnny setup\n'));
    return;
  }
  w(dim.fg('  Johnny can turn your memories into facts, observations and mental models in the background\n'));
  w(dim.fg('  every 3 hours. It runs the `claude` CLI headlessly on new memory text (no tools, capped\n'));
  w(dim.fg('  per run and per day), so it uses your Claude usage and sends that text to Anthropic.\n'));
  if (!(await confirm('Enable automatic knowledge synthesis?'))) {
    await (await import('../../knowledge/heartbeat.js')).setAutoSynth(false);
    w(dim.fg('  skipped · enable later with: johnny synth arm\n'));
    return;
  }
  const { arm, isArmed, setAutoSynth } = await import('../../knowledge/heartbeat.js');
  await setAutoSynth(true);
  try {
    arm();
    w(isArmed() ? neon.green('  ✓ automatic synthesis armed (every 3h, headless)\n') : neon.amber('  ↯ could not arm launchd job · try: johnny synth arm\n'));
  } catch (err) {
    w(neon.amber(`  ↯ could not arm launchd job (${err}) · try: johnny synth arm\n`));
  }
}

// ── skill file reconciliation ─────────────────────────────────────────────────

async function reconcileSkillFiles(): Promise<void> {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  try {
    await fs.access(skillsDir);
  } catch {
    return; // no skills dir — nothing to reconcile
  }

  const { reconcileFromSkillFiles } = await import('./skills.js');
  const count = await reconcileFromSkillFiles(skillsDir);
  if (count > 0) {
    w(dim.fg(`  reconciled ${count} Praxis skill(s) from ~/.claude/skills/\n`));
  }
}
