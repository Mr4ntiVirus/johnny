// First-run memory bootstrap: scans all existing Claude sessions and loads them
// into Johnny's graph. Cinematic boot sequence — Johnny Mnemonic strapped in.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import { getClaudeBaseDir } from '../../vendor/cmv/utils/paths.js';
import { summarizeSession } from '../../engine/summarizer.js';
import { embedMemory } from '../../engine/embedder.js';
import { readGraph, writeGraph, recomputePageRank } from '../../store/graph.js';
import { readState } from '../../store/state.js';
import { readConfig } from '../../store/config.js';
import { isOllamaOnline } from '../../utils/llm.js';
import { log } from '../../utils/log.js';
import { Spinner } from '../../utils/spinner.js';
import { addMemory } from '../../store/memory.js';
import { chunkAndPersistMemory } from '../../engine/chunker.js';
import { analyzeSession } from '../../vendor/cmv/core/analyzer.js';
import { toStagePlayFormat, getUserDisplayName } from '../../utils/transcript.js';
import type { MemoryNode, MemoryGraph } from '../../types.js';

const MIN_SESSION_BYTES = 1_500;  // skip trivially empty sessions

// ── Brand hex (static — no chalk wrappers needed here) ────────────────────────
const C = {
  cyan:    '#00FFE0',
  magenta: '#FF2EA6',
  green:   '#00FF66',
  amber:   '#FFB000',
  red:     '#FF3860',
  fg:      '#D8E4FF',
  dim:     '#4A5568',
};

const cy  = (s: string) => chalk.hex(C.cyan)(s);
const mg  = (s: string) => chalk.hex(C.magenta)(s);
const gr  = (s: string) => chalk.hex(C.green)(s);
const am  = (s: string) => chalk.hex(C.amber)(s);
const dm  = (s: string) => chalk.hex(C.dim)(s);
const fg  = (s: string) => chalk.hex(C.fg)(s);
const bd  = (s: string) => chalk.bold(s);

const w = (s: string) => process.stdout.write(s);
const nl = () => w('\n');

// ── Progress bar ──────────────────────────────────────────────────────────────

function bar(current: number, total: number, width = 36): string {
  const pct = total === 0 ? 1 : Math.min(1, current / total);
  const filled = Math.round(pct * width);
  const empty  = width - filled;
  const barStr = cy('█'.repeat(filled)) + dm('░'.repeat(empty));
  const pctStr = String(Math.round(pct * 100)).padStart(3) + '%';
  return `[${barStr}] ${dm(pctStr)}  ${dm(`${current}/${total}`)}`;
}

// ── Quips ─────────────────────────────────────────────────────────────────────

function quip(text: string): void {
  nl();
  w(`  ${am('"' + text + '"')}`);
  nl();
  nl();
}

// ── Path decode ───────────────────────────────────────────────────────────────

function decodeCwd(dirName: string): string {
  // ~/.claude/projects/ encodes cwd as cwd.replace(/\//g, '-')
  // decode: first char is always '-' (from leading '/')
  return '/' + dirName.slice(1).replace(/-/g, '/');
}

// ── Session discovery ─────────────────────────────────────────────────────────

interface SessionFile {
  jsonlPath: string;
  cwd: string;
  bytes: number;
}

async function discoverSessions(spinner: Spinner): Promise<SessionFile[]> {
  const claudeBase = getClaudeBaseDir();
  const projectsDir = path.join(claudeBase, 'projects');

  let projectDirs: string[] = [];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }

  const sessions: SessionFile[] = [];

  for (const dirName of projectDirs) {
    const cwd = decodeCwd(dirName);
    const dirPath = path.join(projectsDir, dirName);
    spinner.update(`scanning ${dm(cwd.slice(0, 55))}`);

    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dirPath, f);
      try {
        const stat = await fs.stat(jsonlPath);
        if (stat.size >= MIN_SESSION_BYTES) {
          sessions.push({ jsonlPath, cwd, bytes: stat.size });
        }
      } catch { /* skip */ }
    }
  }

  return sessions;
}

function extractTopics(summary: string, slug: string): string[] {
  const words = new Set([
    ...slug.split('-'),
    ...summary.toLowerCase().split(/[\s\W]+/).filter(w => w.length > 3),
  ]);
  return [...words].slice(0, 12);
}

// ── Boot header ───────────────────────────────────────────────────────────────

function printBootHeader(): void {
  const line = cy('═'.repeat(72));
  nl();
  w(cy('╔' + '═'.repeat(72) + '╗')); nl();
  w(cy('║') + bd(mg('  JOHNNYMN.EXE')) +
    dm('  ·  NEURAL BOOTSTRAP  ·  MEMORY LOAD SEQUENCE INITIATED') +
    '  ' + cy('║')); nl();
  w(cy('╚' + '═'.repeat(72) + '╝')); nl();
  nl();
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function cmdBootstrap(skipIfPopulated = false): Promise<void> {
  const [existingGraph, state, config] = await Promise.all([
    readGraph(),
    readState(),
    readConfig(),
  ]);

  const existingCount = Object.keys(existingGraph.memories).length;

  if (skipIfPopulated && existingCount > 0) {
    w(dm(`  wetware already loaded · ${existingCount} memories · skipping bootstrap\n`));
    return;
  }

  printBootHeader();

  // ── Phase 1: Scan ───────────────────────────────────────────────────────────
  w(cy('⟳ ') + bd(fg('NEURAL SCAN')) + dm('  ·  scanning data pathways\n'));
  nl();

  const spinner = new Spinner();
  spinner.start('initializing...');
  const sessions = await discoverSessions(spinner);
  spinner.stop('◈', cy(`${sessions.length} sessions`) + dm(` found across ~/.claude/projects/`));

  if (sessions.length === 0) {
    nl();
    quip("nothing? you've never used claude before. interesting.");
    w(dm('  no sessions to bootstrap from. use claude for a while, then run this again.\n'));
    nl();
    return;
  }

  const totalMB = (sessions.reduce((s, f) => s + f.bytes, 0) / 1_000_000).toFixed(1);
  w(dm(`  ${totalMB} MB of session data\n`));
  nl();

  if (sessions.length > 200) {
    quip("what are you uploading, the library of congress?");
  } else if (sessions.length > 50) {
    quip("you've been busy. I'll manage.");
  } else {
    quip("is that it? I've seen more data in a burner phone.");
  }

  // Filter out already-indexed sessions by snapshotName collision (slug-based)
  const existingSlugs = new Set(
    Object.values(existingGraph.memories).map(m => m.snapshotName),
  );

  // ── Phase 2: Data Intake ────────────────────────────────────────────────────
  w(cy('⟳ ') + bd(fg('DATA INTAKE')) + dm('  ·  synthesizing memories\n'));
  nl();

  // Each entry holds the persisted node + its stage-play transcript for
  // the embed/chunk phases below. addMemory() writes to DB immediately so
  // memories survive even if a later phase fails.
  const newMemories: Array<{ node: MemoryNode; transcriptContent: string }> = [];
  const currentTurn = state.turnCounter;

  // Track quip thresholds
  let quipped25 = false;
  let quipped50 = false;
  let quipped75 = false;

  for (let i = 0; i < sessions.length; i++) {
    const sess = sessions[i];
    const pct = (i + 1) / sessions.length;

    // Progress bar
    w(`\r  ${bar(i + 1, sessions.length)}  \x1b[K`);

    // Johnny quips at thresholds
    if (!quipped25 && pct >= 0.25) {
      quipped25 = true;
      nl(); nl();
      quip("these sessions go back how far? who does that.");
      w(`  ${bar(i + 1, sessions.length)}  \x1b[K`);
    }
    if (!quipped50 && pct >= 0.50) {
      quipped50 = true;
      nl(); nl();
      quip("halfway. still alive? good.");
      w(`  ${bar(i + 1, sessions.length)}  \x1b[K`);
    }
    if (!quipped75 && pct >= 0.75) {
      quipped75 = true;
      nl(); nl();
      quip("synthesizing... there's a lot of junk in here.");
      w(`  ${bar(i + 1, sessions.length)}  \x1b[K`);
    }

    try {
      const { slug, summary, title } = await summarizeSession(sess.jsonlPath);
      if (existingSlugs.has(slug)) continue;

      const [analysis, rawTranscript] = await Promise.all([
        analyzeSession(sess.jsonlPath),
        fs.readFile(sess.jsonlPath, 'utf-8'),
      ]);

      const transcriptContent = toStagePlayFormat(rawTranscript, { userName: getUserDisplayName() });
      const topics = extractTopics(summary, slug);
      const node = await addMemory(
        slug, title, summary, transcriptContent,
        sess.cwd, analysis.estimatedTokens, topics, currentTurn,
      );
      newMemories.push({ node, transcriptContent });

      w(`\r  ${bar(i + 1, sessions.length)}  ${dm(slug.slice(0, 28))}\x1b[K`);
    } catch (err) {
      await log(`bootstrap: error on ${sess.jsonlPath}: ${err}`);
    }
  }

  w('\r\x1b[K');
  w(`  ${cy('◈')} ${cy(String(newMemories.length))} ${dm('memories synthesized')}\n`);
  nl();

  // ── Phase 3: Embed ──────────────────────────────────────────────────────────
  const ollamaUp = await isOllamaOnline();
  let embeddedCount = 0;

  if (ollamaUp && newMemories.length > 0) {
    w(cy('⟳ ') + bd(fg('EMBEDDING PATTERNS')) + dm('  ·  mxbai-embed-large\n'));
    nl();
    quip("embedding neural patterns. the math part. don't rush me.");

    for (let i = 0; i < newMemories.length; i++) {
      w(`\r  ${bar(i + 1, newMemories.length)}\x1b[K`);
      try {
        await embedMemory(newMemories[i].node);
        embeddedCount++;
      } catch { /* Ollama hiccup — leave embedding null */ }
    }

    w('\r\x1b[K');
    w(`  ${cy('◈')} ${cy(String(embeddedCount))} ${dm('patterns embedded')}\n`);
    nl();

    // Phase G: chunk each new memory for Mosaic Recall.
    w(dm('  chunking for mosaic recall...\n'));
    for (const { node, transcriptContent } of newMemories) {
      try {
        await chunkAndPersistMemory(node.id, node.snapshotName, transcriptContent);
      } catch { /* non-blocking */ }
    }
  } else if (!ollamaUp) {
    w(dm('  ⊘ ollama offline · embeddings deferred · recall will improve once online\n'));
    nl();
  }

  // ── Phase 4: Graph ──────────────────────────────────────────────────────────
  w(cy('⟳ ') + bd(fg('WEAVING ASSOCIATION MATRIX')) + dm('  ·  computing PageRank\n'));
  nl();
  quip("weaving the association matrix. this is the part that usually kills people.");

  // Reload graph from DB — memories are now persisted so this picks them all up.
  const graph: MemoryGraph<MemoryNode> = await readGraph();

  if (Object.keys(graph.memories).length > 1) {
    spinner.start('computing PageRank...');
    recomputePageRank(graph, config, currentTurn);
    spinner.stop('◈', dm('PageRank stable'));
  }

  spinner.start('writing wetware...');
  await writeGraph(graph);
  spinner.stop('◈', dm('written'));
  nl();

  await log(`bootstrap: loaded ${newMemories.length} new memories`);

  // ── Complete ─────────────────────────────────────────────────────────────────
  const totalNow = Object.keys(graph.memories).length;

  w(cy('◈ ') + bd(cy('LOAD COMPLETE')) + '  ' + cy('─'.repeat(40)) + '\n');
  nl();
  w(`  ${cy(String(totalNow))} ${fg('memories total')}  ·  ` +
    `${cy(String(newMemories.length))} ${fg('new')}  ·  ` +
    `${cy(String(embeddedCount))} ${fg('embedded')}  ·  ` +
    `${cy(totalMB + ' MB')} ${fg('indexed')}\n`);
  nl();

  if (newMemories.length > 50) {
    quip("Whoah. I know kung-fu.");
  } else if (newMemories.length > 10) {
    quip("alright. I've got it all. try not to make it weirder.");
  } else {
    quip("not much to work with. I'll make it count.");
  }

  if (!ollamaUp) {
    w(dm('  tip: start ollama and run ') + cy('johnny bootstrap') +
      dm(' again to embed the remaining memories.\n'));
    nl();
  }

  w(dm('  use ') + cy('johnny graph') + dm(' to explore what I know.\n'));
  nl();
}
