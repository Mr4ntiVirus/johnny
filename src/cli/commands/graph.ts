import * as fs from 'node:fs/promises';
import { closeDatabase } from '../../store/database.js';
import * as path from 'node:path';
import { readGraphFull, topCandidates } from '../../store/graph.js';
import { readState } from '../../store/state.js';
import { readConfig } from '../../store/config.js';
import * as memoriesDb from '../../store/db/memories.js';
import * as edgesDb from '../../store/db/edges.js';
import { neon, ink, dim } from '../../brand/tokens.js';

function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

// ── help ──────────────────────────────────────────────────────────────────────

const HELP = `
  ${neon.cyan('johnny graph')} — inspect the memory graph

  ${dim.fg('usage:')}
    johnny graph              ${dim.fg('# summary table, top 100 by rank')}
    johnny graph --json       ${dim.fg('# machine-readable JSON')}
    johnny graph --tui        ${dim.fg('# interactive terminal UI (ink)')}
    johnny graph --help       ${dim.fg('# this message')}
`;

function knownFlag(a: string): boolean {
  return a === '--json' || a === '--tui' || a === '--help' || a === '-h';
}

// ── main command ──────────────────────────────────────────────────────────────

export async function cmdGraph(args: string[]): Promise<void> {
  try {
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(HELP);
      return;
    }

    const unknown = args.filter(a => a.startsWith('-') && !knownFlag(a));
    if (unknown.length > 0) {
      process.stderr.write(neon.red(`× unknown flag: ${unknown[0]}\n`));
      process.stdout.write(HELP);
      return;
    }

    const jsonFlag = args.includes('--json');
    const tuiFlag = args.includes('--tui');

    const [memories, edgeStats] = await Promise.all([
      memoriesDb.listMemories({ limit: 100, orderBy: 'rank' }),
      edgesDb.getEdgeStats(),
    ]);

    if (memories.length === 0 && !tuiFlag) {
      process.stdout.write(dim.fg('  nothing in the wetware yet\n'));
      return;
    }

    // Run TUI
    if (tuiFlag) {
      const [graph, state, config] = await Promise.all([
        readGraphFull(),
        readState(),
        readConfig(),
      ]);
      const currentTurn = state.turnCounter;
      const { runGraphTui } = await import('./graph-tui.js');
      await runGraphTui(graph, currentTurn, config);
      return;
    }

    if (memories.length === 0) {
      process.stdout.write(dim.fg('  nothing in the wetware yet\n'));
      return;
    }

    // JSON output
    if (jsonFlag) {
      const scored = memories.map(m => ({
        title: m.title,
        slug: m.snapshot_name,
        rank: m.rank,
        retrievalCount: m.retrieval_count,
        tokenCount: m.token_count,
        contentType: m.content_type,
        createdAt: m.created_at,
      }));
      process.stdout.write(JSON.stringify(scored, null, 2));
      return;
    }

    // Simple text output
    const header = `  ${dim.fg('title'.padEnd(30))} ${dim.fg('rank'.padEnd(8))} ${dim.fg('tokens')}`;
    const rule80 = dim.fg('─'.repeat(80));

    const lines: string[] = [
      '',
      `  ${neon.cyan(`${memories.length} memories`)} ${dim.fg(`· ${edgeStats.totalEdges} edges`)}`,
      `  ${rule80}`,
      header,
      `  ${rule80}`,
    ];

    for (const m of memories) {
      const title = m.title.slice(0, 28).padEnd(30);
      const rank = fmt(m.rank, 2).padEnd(8);
      const tokens = String(m.token_count);
      lines.push(`  ${ink.fg(title)} ${dim.fg(rank)} ${dim.fg(tokens)}`);
    }

    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    closeDatabase();
  }
}