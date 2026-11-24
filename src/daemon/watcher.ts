// Watches ~/.claude/projects/ for JSONL session activity.
// On change: checks context pressure and triggers auto-snapshot if needed.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getClaudeProjectsDir } from '../vendor/cmv/utils/paths.js';
import { log } from '../utils/log.js';
import { isBypassed } from '../utils/bypass.js';
import { recordHeartbeat } from '../store/db/heartbeats.js';

type Watcher = ReturnType<typeof fs.watch>;

const watchers = new Map<string, Watcher>();
let rootWatcher: Watcher | null = null;

const DEBOUNCE_MS = 3000; // wait 3s after last change before acting
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// dist/daemon/watcher.js -> dist/cli/index.js
const selfPath = fileURLToPath(import.meta.url);
const cliEntry = path.resolve(path.dirname(selfPath), '..', 'cli', 'index.js');

// Runs the same `johnny post-turn` subprocess Claude Code's own PostToolUse hook
// invokes, rather than calling runPostTurnHook in-process, so a crash in the
// trim/snapshot path cannot take the daemon down.
// Exported for tests — spawn behavior is asserted directly rather than
// indirectly through fs.watch + the 3s debounce.
export async function runPostTurnHook(jsonlPath: string): Promise<void> {
  const sessionId = path.basename(jsonlPath, '.jsonl');
  const payload = JSON.stringify({ transcript_path: jsonlPath, session_id: sessionId });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, 'post-turn'], {
      env: { ...process.env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr) reject(new Error(`post-turn exited ${code}: ${stderr.trim()}`));
      else resolve();
    });
    child.stdin.write(payload, (err) => {
      if (err) { reject(err); return; }
      child.stdin.end();
    });
  });
}

async function onSessionChanged(jsonlPath: string): Promise<void> {
  if (isBypassed()) return;
  try { recordHeartbeat('watcher'); } catch { /* best-effort */ }

  // Debounce rapid writes (tool calls can produce many JSONL appends)
  const existing = debounceTimers.get(jsonlPath);
  if (existing) clearTimeout(existing);
  debounceTimers.set(jsonlPath, setTimeout(async () => {
    debounceTimers.delete(jsonlPath);
    try {
      await runPostTurnHook(jsonlPath);
      try { recordHeartbeat('watcher', { didWork: true }); } catch { /* best-effort */ }
    } catch (e) {
      await log(`watcher: post-turn error for ${jsonlPath} — ${e}`);
      try { recordHeartbeat('watcher', { status: 'error' }); } catch { /* best-effort */ }
    }
  }, DEBOUNCE_MS));
}

function watchProjectDir(projectDir: string): void {
  if (watchers.has(projectDir)) return;
  try {
    const w = fs.watch(projectDir, { persistent: false }, async (event, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      const jsonlPath = path.join(projectDir, filename);
      await onSessionChanged(jsonlPath).catch(() => { /* swallow */ });
    });
    w.on('error', () => { watchers.delete(projectDir); });
    watchers.set(projectDir, w);
  } catch {
    // project dir may not exist yet
  }
}

async function scanAndWatch(): Promise<void> {
  const projectsDir = getClaudeProjectsDir();
  try {
    const entries = await fsp.readdir(projectsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        watchProjectDir(path.join(projectsDir, e.name));
      }
    }
  } catch { /* projects dir may not exist */ }
}

export async function startWatcher(): Promise<void> {
  const projectsDir = getClaudeProjectsDir();

  // Claude Code creates this directory lazily on first real session — on a
  // freshly-provisioned container it may not exist yet when the daemon boots,
  // which previously made fs.watch() throw ENOENT and silently never attach.
  try {
    await fsp.mkdir(projectsDir, { recursive: true });
  } catch (e) {
    await log(`watcher: failed to create projects dir ${projectsDir} — ${e}`);
  }

  await scanAndWatch();

  // Watch the projects root for new project dirs
  try {
    rootWatcher = fs.watch(projectsDir, { persistent: false }, async (event, filename) => {
      if (filename) await scanAndWatch().catch(() => { /* swallow */ });
    });
    rootWatcher.on('error', () => { rootWatcher = null; });
  } catch (e) {
    await log(`watcher: failed to attach root watcher on ${projectsDir} — ${e}`);
  }

  await log('watcher: started');
}

export function stopWatcher(): void {
  for (const w of watchers.values()) { try { w.close(); } catch { /* ok */ } }
  watchers.clear();
  if (rootWatcher) { try { rootWatcher.close(); } catch { /* ok */ } rootWatcher = null; }
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
}
