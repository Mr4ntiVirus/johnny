// johnny show <slug> — print a named memory's transcript to stdout.
// Useful for piping to `less` or comparing memories directly.
//
// Usage:
//   johnny show <slug>              # full transcript
//   johnny show <slug> --tail N     # last N lines (default 100)
//   johnny show <slug> --meta       # metadata only, no transcript

import * as memoriesDb from '../../store/db/memories.js';
import * as transcriptsDb from '../../store/db/transcripts.js';
import { neon, ink, dim } from '../../brand/tokens.js';

const w = (s: string) => process.stdout.write(s);

export async function cmdShow(args: string[]): Promise<void> {
  const slug = args.find(a => !a.startsWith('-'));
  if (!slug) {
    process.stderr.write('Usage: johnny show <slug> [--tail N] [--meta]\n');
    process.exit(1);
  }

  const tailIdx = args.indexOf('--tail');
  const tailN = tailIdx !== -1 ? parseInt(args[tailIdx + 1] ?? '100', 10) : null;
  const metaOnly = args.includes('--meta');

  const rec = await memoriesDb.getMemoryBySnapshot(slug);
  if (!rec) {
    process.stderr.write(`No memory named "${slug}". Try \`johnny graph\` to list memories.\n`);
    process.exit(1);
  }

  const tr = await transcriptsDb.getTranscript(rec.id);
  const topics: string[] = tr?.topics ? (JSON.parse(tr.topics) as string[]) : [];

  // Metadata header
  w('\n');
  w(neon.cyan('◈ ') + ink.fg(rec.snapshot_name) + '\n');
  w(dim.fg('─'.repeat(60)) + '\n');
  w(dim.fg('  title     ') + ink.fg(rec.title.slice(0, 70)) + '\n');
  w(dim.fg('  rank      ') + ink.fg(rec.rank.toFixed(3)) + '\n');
  w(dim.fg('  tokens    ') + ink.fg(String(rec.token_count)) + '\n');
  w(dim.fg('  retrievals') + ink.fg(String(rec.retrieval_count)) + '\n');
  w(dim.fg('  created   ') + ink.fg(rec.created_at.slice(0, 19)) + '\n');
  if (rec.project_path) {
    w(dim.fg('  project   ') + ink.fg(rec.project_path.slice(0, 70)) + '\n');
  }
  if (topics.length > 0) {
    w(dim.fg('  topics    ') + dim.fg(topics.slice(0, 10).join(', ')) + '\n');
  }
  if (tr?.skill_name) {
    w(dim.fg('  skill     ') + neon.cyan(tr.skill_name) + '\n');
  }
  w(dim.fg('─'.repeat(60)) + '\n');

  if (metaOnly) return;

  const transcript = tr?.transcript ?? '';
  if (!transcript) {
    w(dim.fg('  (no transcript stored)\n\n'));
    return;
  }

  const lines = transcript.split('\n');
  const toShow = tailN !== null ? lines.slice(-tailN) : lines;

  if (tailN !== null && lines.length > tailN) {
    w(dim.fg(`  … ${lines.length - tailN} lines above (showing last ${tailN}) …\n\n`));
  }

  w('\n');
  for (const line of toShow) {
    w(line + '\n');
  }
  w('\n');
}
