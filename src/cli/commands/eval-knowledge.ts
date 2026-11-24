// johnny eval-knowledge — scores the compiled knowledge layer against your
// hand-written memory notes (the gold standard for what "good" looks like).
//
// For every note under ~/.claude/projects/*/memory/*.md it derives must-have
// phrases (backticked identifiers/paths/commands, ISO dates, ports and other
// numbers with context) and measures the share present anywhere in the
// compiled layers (active models + observations + facts). Coverage, not
// correctness: contradictions against a note are reviewed by hand from the
// per-note "missing" lists. Read-only.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as modelsDb from '../../store/db/mental-models.js';
import * as obsDb from '../../store/db/observations.js';
import * as factsDb from '../../store/db/facts.js';

export function mustHavePhrases(md: string): string[] {
  const body = md.replace(/^---[\s\S]*?---/, ''); // drop frontmatter
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]{4,60})`/g)) out.add(m[1].trim());
  for (const m of body.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)) out.add(m[0]);
  for (const m of body.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev)\b/gi)) out.add(m[0].toLowerCase());
  return [...out].filter(p => !/^\s*$/.test(p)).slice(0, 40);
}

export function coverageOf(phrases: string[], corpusLower: string): { hit: string[]; missing: string[] } {
  const hit: string[] = []; const missing: string[] = [];
  for (const p of phrases) (corpusLower.includes(p.toLowerCase()) ? hit : missing).push(p);
  return { hit, missing };
}

export async function cmdEvalKnowledge(args: string[]): Promise<void> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files: string[] = [];
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj, 'memory');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md') && f !== 'MEMORY.md') files.push(path.join(dir, f));
  }
  const filter = args.find(a => a.startsWith('--match='))?.split('=')[1];
  const selected = filter ? files.filter(f => f.includes(filter)) : files;

  const models = await modelsDb.listModels({ status: 'active' });
  const obs = await obsDb.listActiveObservations(null, 20000);
  const facts = await factsDb.listActiveFacts(null, 50000);
  const corpus = [...models.map(m => m.content ?? ''), ...obs.map(o => o.text), ...facts.map(f => f.text)].join('\n').toLowerCase();

  let hitTotal = 0, phraseTotal = 0;
  const rows: Array<{ file: string; phrases: number; hit: number; missing: string[] }> = [];
  for (const f of selected) {
    const phrases = mustHavePhrases(fs.readFileSync(f, 'utf-8'));
    if (phrases.length === 0) continue;
    const { hit, missing } = coverageOf(phrases, corpus);
    hitTotal += hit.length; phraseTotal += phrases.length;
    rows.push({ file: path.basename(f), phrases: phrases.length, hit: hit.length, missing });
  }
  rows.sort((a, b) => a.hit / a.phrases - b.hit / b.phrases);
  process.stdout.write(`eval-knowledge · ${models.length} models · ${obs.length} observations · ${facts.length} facts · ${selected.length} gold notes\n`);
  process.stdout.write(`overall coverage ${phraseTotal ? ((100 * hitTotal) / phraseTotal).toFixed(1) : '0'}% (${hitTotal}/${phraseTotal} must-have phrases)\n\n`);
  for (const r of rows.slice(0, args.includes('--all') ? rows.length : 15)) {
    process.stdout.write(`${((100 * r.hit) / r.phrases).toFixed(0).padStart(3)}%  ${r.file}  (${r.hit}/${r.phrases})  missing: ${r.missing.slice(0, 5).join(' · ')}\n`);
  }
}
