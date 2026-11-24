// Suppress priming when the knowledge is ALREADY in context that Claude Code
// loads for this working directory (CLAUDE.md chain + the project's
// MEMORY.md index). Priming a fact the model already has wastes attention —
// the context-injection principle outranks completeness.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_FILE_BYTES = 400_000;

function readIfExists(p: string): string {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(p, 'utf-8');
  } catch { return ''; }
}

/** Claude Code stores per-project memory under ~/.claude/projects/<path with / -> ->/memory/. */
export function projectMemoryDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let cur = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    dirs.push(path.join(os.homedir(), '.claude', 'projects', cur.replace(/[\\/._]/g, '-'), 'memory'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** Text of every always-loaded context file relevant to `cwd`. */
export function loadedContextText(cwd: string): string {
  const parts: string[] = [readIfExists(path.join(os.homedir(), '.claude', 'CLAUDE.md'))];
  let cur = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    parts.push(readIfExists(path.join(cur, 'CLAUDE.md')));
    parts.push(readIfExists(path.join(cur, '.claude', 'CLAUDE.md')));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of projectMemoryDirs(cwd)) parts.push(readIfExists(path.join(d, 'MEMORY.md')));
  return parts.join('\n');
}

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'has', 'have', 'not', 'but', 'its', 'can', 'will', 'when', 'than', 'then', 'into', 'all', 'use', 'uses', 'used', 'using']);

/** Distinctive tokens of a text: numbers/ids, hostnames, paths, and non-stopword words ≥4 chars. */
export function keyTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.:/@-]{3,}/g)) {
    const t = m[0].replace(/[.:,;]+$/, '');
    if (t.length >= 4 && !STOP.has(t)) out.add(t);
  }
  return out;
}

/** Fraction of `text`'s key tokens that already appear in `corpus` (0..1). */
export function coverage(text: string, corpus: string): number {
  const tokens = keyTokens(text);
  if (tokens.size === 0) return 0;
  const hay = corpus.toLowerCase();
  let hit = 0;
  for (const t of tokens) if (hay.includes(t)) hit++;
  return hit / tokens.size;
}

export const ALREADY_LOADED_COVERAGE = 0.75;

export function isAlreadyLoaded(text: string, corpus: string): boolean {
  return corpus.length > 0 && coverage(text, corpus) >= ALREADY_LOADED_COVERAGE;
}
