// johnny resummarize — rewrite generic memory summaries from the memory's own stored text (dry run by default).
//   --mined [--sessions=N --per-band=N]   target the memories real prompts actually matched (pilot / A-B set)
//   --generic --limit=N                   target N generic-summary memories, newest first
//   --ids=a,b                             explicit ids
//   --apply                               write changes (journaled for --revert) and re-embed
//   --revert                              restore every title/summary changed through the journal
// Local store only.

import * as fs from 'node:fs';
import { readKnowledgeConfig } from '../../knowledge/config.js';
import { ClaudeCliSynthesizer, SynthRateLimitError } from '../../knowledge/synth.js';
import { listMemories } from '../../store/db/memories.js';
import { applyResummary, isGenericSummary, resummarize, revertAll, journalPath, doneIds, markNoContent } from '../../maintenance/resummarize.js';
import { minePrompts } from './eval-recommend.js';

export async function cmdResummarize(args: string[]): Promise<void> {
  const arg = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  if (args.includes('--revert')) {
    process.stdout.write(`reverted ${await revertAll()} memories from ${journalPath()}\n`);
    return;
  }
  const apply = args.includes('--apply');
  let ids: string[] = [];
  if (arg('ids')) ids = arg('ids')!.split(',');
  else if (args.includes('--mined')) {
    const m = await minePrompts(Number(arg('sessions') ?? 150), 12, Number(arg('per-band') ?? 20));
    ids = [...new Set(m.rows.map(r => r.memoryId))];
    if (arg('pairs')) fs.writeFileSync(arg('pairs')!, JSON.stringify(m.rows));   // fixed (prompt, memory) pairs for before/after judging
  } else if (args.includes('--generic')) {
    // Highest rank first: those are the memories recall is most likely to match. Memories already rewritten
    // (journaled) or that earlier slices found to have no specific content are skipped so slices make progress.
    const done = doneIds();
    const all = await listMemories({ limit: 20000, orderBy: 'rank' });
    ids = all.filter(r => isGenericSummary(r.summary) && !done.has(r.id)).slice(0, Number(arg('limit') ?? 25)).map(r => r.id);
  } else {
    process.stderr.write('usage: johnny resummarize (--mined | --generic --limit=N | --ids=a,b) [--apply] | --revert\n');
    process.exit(2);
  }
  const cfg = await readKnowledgeConfig();
  const synth = new ClaudeCliSynthesizer({ defaultModel: cfg.synth.defaultModel, models: cfg.synth.models });
  let changed = 0, skipped = 0;
  for (const id of ids) {
    try {
      const { old, next } = await resummarize(synth, id);
      if (!next) { skipped++; if (apply) markNoContent(id); continue; }
      process.stdout.write(`${id.slice(0, 8)}\n  - ${old.summary ?? ''}\n  + ${next.summary}\n`);
      if (apply) await applyResummary(id, next);
      changed++;
    } catch (err) {
      process.stderr.write(`${id.slice(0, 8)} failed: ${err}\n`);
      // Rate limit / auth outage: every further call would fail too. Stop; the next slice resumes via the journal.
      if (err instanceof SynthRateLimitError) { process.stderr.write('stopping: rate limited or not logged in\n'); break; }
    }
  }
  process.stdout.write(`\n${apply ? 'applied' : 'dry run:'} ${changed} rewritten, ${skipped} skipped (no specific content) of ${ids.length}${apply ? `; journal ${journalPath()}` : ' (re-run with --apply)'}\n`);
}
