// johnny validate — memory integrity report.

import { query, queryOne } from '../../store/db-client.js';
import * as memoriesDb from '../../store/db/memories.js';
import { neon, ink, dim } from '../../brand/tokens.js';

const w = (s: string) => process.stdout.write(s);

interface HeadGroup { head: string; n: number; }
interface TokenStats { min: number; max: number; median: number; total: number; }

function computeTokenStats(counts: number[]): TokenStats {
  if (counts.length === 0) return { min: 0, max: 0, median: 0, total: 0 };
  const sorted = [...counts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : (sorted[mid] ?? 0);
  return { min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, median, total: sorted.reduce((s, v) => s + v, 0) };
}

function alert(msg: string): string { return neon.red('  ← ') + dim.fg(msg); }
function ok(msg: string): string { return neon.green('  ✓ ') + dim.fg(msg); }

export async function cmdValidate(): Promise<void> {
  const totalMemories = await memoriesDb.getMemoryCount();
  w('\n');
  w(neon.cyan('◈ memory integrity report') + dim.fg(`  ·  ${totalMemories} memories`) + '\n\n');

  const [transcriptStats, headGroups, tokenRows, embeddingStats, chunkStats] = await Promise.all([
    queryOne<{ total: number; with_transcript: number; empty: number }>(`
      SELECT COUNT(*) as total, COUNT(t.memory_id) as with_transcript,
             COUNT(CASE WHEN t.transcript IS NULL OR t.transcript = '' THEN 1 END) as empty
      FROM memories m LEFT JOIN transcripts t ON t.memory_id = m.id`),
    query<HeadGroup>(`
      SELECT SUBSTR(transcript, 1, 200) as head, COUNT(*) as n
      FROM transcripts WHERE transcript IS NOT NULL AND transcript != ''
      GROUP BY head ORDER BY n DESC`),
    query<{ token_count: number }>('SELECT token_count FROM memories'),
    queryOne<{ total: number; embedded: number }>(`
      SELECT COUNT(*) as total, COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END) as embedded
      FROM transcripts`),
    queryOne<{ chunked_memories: number; total_chunks: number }>(`
      SELECT COUNT(DISTINCT memory_id) as chunked_memories, COUNT(*) as total_chunks FROM chunks`),
  ]);

  const ts = transcriptStats ?? { total: 0, with_transcript: 0, empty: 0 };
  w(ink.fg('  transcripts\n'));
  w(dim.fg('    populated:     ') + ink.fg(`${ts.with_transcript} / ${ts.total}`) +
    (ts.empty > 0 ? alert(`${ts.empty} empty`) : ok('all populated')) + '\n');

  const duplicateGroups = headGroups.filter(g => g.n > 1);
  const duplicateMemories = duplicateGroups.reduce((s, g) => s + g.n - 1, 0);
  w(dim.fg('    unique opens:  ') + ink.fg(String(headGroups.length)) +
    (duplicateGroups.length > 0
      ? alert(`${duplicateMemories} redundant (${duplicateGroups.length} group${duplicateGroups.length > 1 ? 's' : ''})`)
      : ok('no duplicates')) + '\n');

  if (duplicateGroups.length > 0) {
    w('\n');
    w(ink.fg('  per-session groups\n'));
    for (const g of duplicateGroups.slice(0, 8)) {
      const preview = g.head.slice(0, 60).replace(/\n/g, ' ');
      const flag = g.n > 20 ? neon.red(`${g.n} members`) : g.n > 5 ? neon.amber(`${g.n} members`) : dim.fg(`${g.n} members`);
      w(`    ${flag}${dim.fg('  · ')}${dim.fg(preview + '…')}\n`);
      w(`    ${dim.fg(`→ ${g.n - 1} redundant`)}\n\n`);
    }
    if (duplicateGroups.length > 8) w(dim.fg(`    … and ${duplicateGroups.length - 8} more groups\n\n`));
  }

  const stats = computeTokenStats(tokenRows.map(r => r.token_count));
  w(ink.fg('  token distribution\n'));
  w(dim.fg('    median:  ') + ink.fg(`${stats.median.toLocaleString()}`) + '\n');
  w(dim.fg('    min:     ') + dim.fg(`${stats.min.toLocaleString()}`) + '\n');
  w(dim.fg('    max:     ') + ink.fg(`${stats.max.toLocaleString()}`) + '\n');
  w(dim.fg('    total:   ') + dim.fg(`~${(stats.total / 200).toFixed(0)}k tokens`) + '\n');

  const es = embeddingStats ?? { total: 0, embedded: 0 };
  const unembedded = es.total - es.embedded;
  w('\n');
  w(ink.fg('  embeddings\n'));
  w(dim.fg('    embedded:      ') + ink.fg(`${es.embedded} / ${es.total}`) +
    (unembedded > 0 ? alert(`${unembedded} not yet embedded`) : ok('all embedded')) + '\n');

  const cs = chunkStats ?? { chunked_memories: 0, total_chunks: 0 };
  const unchunked = totalMemories - cs.chunked_memories;
  w('\n');
  w(ink.fg('  chunks (Mosaic Recall)\n'));
  w(dim.fg('    chunked:       ') + ink.fg(`${cs.chunked_memories} / ${totalMemories} memories`) +
    dim.fg(`  ·  ${cs.total_chunks} total chunks`) + '\n');
  if (unchunked > 0) w(dim.fg('                   ') + alert(`${unchunked} not chunked`) + '\n');

  w('\n');
  if (duplicateGroups.length > 0) {
    w(neon.amber('  ↯ ') + neon.amber(`${duplicateMemories}`) + dim.fg(' redundant legacy memories detected.') + '\n\n');
  } else if (unembedded > 0 || unchunked > 0) {
    w(neon.cyan('  ◈ ') + dim.fg('run ') + ink.fg('johnny sleep') + dim.fg(' to embed and chunk unprocessed memories') + '\n\n');
  } else {
    w(neon.green('  ✓ ') + dim.fg('memory graph is clean') + '\n\n');
  }
}
