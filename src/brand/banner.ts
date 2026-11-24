// Intro banner: figlet "JOHNNY" + cyan→magenta gradient + live tagline.
// printBanner()     → full interactive banner (install / status)
// printHookBanner() → minimal single stderr line for hook first-fire
import figlet from 'figlet';
import gradient from 'gradient-string';
import { createRequire } from 'node:module';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getCmvSnapshotsDir } from '../vendor/cmv/utils/paths.js';
import { readGraph, INTERACTIVE_EDGE_LIMIT } from '../store/graph.js';
import { readState } from '../store/state.js';
import { getClaudeSettingsPath } from '../vendor/cmv/utils/paths.js';
import { readJsonFile } from '../utils/jsonl.js';
import { PATHS } from '../store/paths.js';
import { dim, neon } from './tokens.js';
import { top, bot, row, getWidth } from './bbs.js';

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try { return (require('../../package.json') as { version: string }).version; } catch { return '0.1.0'; }
})();

// CP2077 color story: amber/gold body fading to electric teal
const AMBER_HEX = '#FFB000';
const CYAN_HEX  = '#00FFE0';

// Diagonal slash artifacts — the CP2077 speed-line / data-corruption look
const SLASH_RUNS = ['///', '////', '//', '\\\\', '\\/'];

function glitch(art: string): string {
  const lines = art.split('\n');
  return lines.map((line, i) => {
    const r = Math.random();
    // ~30% of lines untouched
    if (r > 0.70) return line;
    // ~10% of lines get a diagonal slash injected at a random position
    if (r < 0.10 && line.trim().length > 0) {
      const pos = Math.floor(Math.random() * Math.max(1, line.length - 4));
      const slash = SLASH_RUNS[Math.floor(Math.random() * SLASH_RUNS.length)];
      return line.slice(0, pos) + slash + line.slice(pos + slash.length);
    }
    // remaining: light char-level decay on non-space chars
    return line.split('').map(c => {
      if (c === ' ') return c;
      const cr = Math.random();
      if (cr < 0.025) return '/';
      if (cr < 0.04)  return '_';
      return c;
    }).join('');
  }).join('\n');
}

function wordmark(): string {
  const raw = figlet.textSync('JOHNNY', { font: 'Lean' });
  const damaged = glitch(raw);
  const noColor = process.env.NO_COLOR || !process.stdout.isTTY;
  return noColor ? damaged : gradient([AMBER_HEX, CYAN_HEX]).multiline(damaged);
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirBytes(full);
      else total += (await fsp.stat(full)).size;
    }
  } catch { /* dir missing */ }
  return total;
}

async function fileBytes(p: string): Promise<number> {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

function formatSize(bytes: number): string {
  if (bytes < 1_000_000)       return `${Math.round(bytes / 1_000)} kilobytes`;
  if (bytes < 1_000_000_000)   return `${Math.round(bytes / 1_000_000)} megs`;
  return `${(bytes / 1_000_000_000).toFixed(1)} gigs`;
}

async function tagline(): Promise<string> {
  const [snapBytes, dbBytes, graph] = await Promise.all([
    dirBytes(getCmvSnapshotsDir()),
    fileBytes(PATHS.database),
    readGraph(INTERACTIVE_EDGE_LIMIT).catch(() => ({ memories: {} as Record<string, unknown> })),
  ]);
  const totalBytes = snapBytes + dbBytes;
  const subjects = Object.keys(graph.memories).length;
  if (subjects === 0) return 'cold start · nothing in my head yet';
  const size = formatSize(totalBytes);
  return `I have ${size} in my head · ${subjects} ${subjects === 1 ? 'subject' : 'subjects'}`;
}

async function hooksLine(): Promise<string> {
  try {
    const settings = await readJsonFile<Record<string, unknown>>(getClaudeSettingsPath());
    const hooks = (settings?.hooks ?? {}) as Record<string, unknown[]>;
    const hasJohnny = Object.values(hooks).some(arr =>
      (arr as any[]).some(e => (e as any).hooks?.some((h: any) => /\bjohnny\s+(evaluate|pre-compact|post-turn|post-compact)\b/.test(String(h.command ?? ''))))
    );
    return hasJohnny ? 'hooks ok' : 'hooks missing';
  } catch { return 'hooks unknown'; }
}

export async function printBanner(): Promise<void> {
  const [tag, hooksStatus, state] = await Promise.all([tagline(), hooksLine(), readState().catch(() => ({ turnCounter: 0 }))]);

  const mark = wordmark();
  const w = (s: string) => process.stdout.write(s + '\n');

  w('');
  w(top());
  w(row(''));
  mark.split('\n').forEach(line => w(dim.fg('|') + '  ' + line));
  w(row(''));
  w(row(neon.amber(tag)));
  const ver = VERSION.split('.').join('·');
  w(row(dim.fg(`ml context librarian  ·  v${ver}  ·  t${state.turnCounter}  ·  ${hooksStatus}`)));
  w(row(''));
  w(bot());
  w('');
}

// First-fire banner for hook sessions. Goes to stderr (stdout must stay clean JSON).
// Strips ANSI when stderr isn't a TTY or NO_COLOR is set — Claude Code may pipe
// hook stderr to a non-TTY destination, where raw escape codes would land in logs.
export async function printHookBanner(): Promise<void> {
  const [graph, state] = await Promise.all([
    readGraph(INTERACTIVE_EDGE_LIMIT).catch(() => ({ memories: {} as Record<string, unknown> })),
    readState().catch(() => ({ turnCounter: 0 })),
  ]);
  const subjects = Object.keys(graph.memories).length;
  const subjectLabel = subjects === 0 ? 'cold start' : `${subjects} ${subjects === 1 ? 'subject' : 'subjects'}`;
  const se = (s: string) => process.stderr.write(s + '\n');

  const useColor = !process.env.NO_COLOR && process.stderr.isTTY === true;
  if (useColor) {
    const rule = dim.fg('|' + '-'.repeat(Math.min(50, getWidth())) + '|');
    se(rule);
    se(dim.fg('|') + neon.amber(`== JOHNNY ONLINE ==`) + dim.fg('  ') + neon.cyan(`${subjectLabel}`) + dim.fg(`  ·  t${state.turnCounter}`));
    se(rule);
  } else {
    const rule = '|' + '-'.repeat(Math.min(50, getWidth())) + '|';
    se(rule);
    se(`| == JOHNNY ONLINE ==  ${subjectLabel}  ·  t${state.turnCounter}`);
    se(rule);
  }
}
