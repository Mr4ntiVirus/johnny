// johnny eval-prime — measures automatic-priming PRECISION on real prompts before
// (and after) the global `knowledge.prime` switch is flipped. Read-only: nothing is
// written to the surfaced map; every prompt is judged independently as a trigger turn.
//
// Samples a few user prompts from each of the most recent Claude Code sessions
// (the same text the UserPromptSubmit hook would see), runs the real priming
// decision against the compiled knowledge, and reports how often a prime fires,
// what it primes, and how often a second item rides along.
//
// `--tool` replays shell commands instead of prompts (the opt-in PreToolUse hook): see eval-prime-tool.ts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { embed } from '../../utils/llm.js';
import { readKnowledgeConfig } from '../../knowledge/config.js';
import { computePrime, type PrimeTrace } from '../../knowledge/prime.js';
import { isSystemNotificationPrompt } from '../evaluate.js';
import { ClaudeCliSynthesizer } from '../../knowledge/synth.js';
import { labelKey, loadLabels, saveLabels, judgePrime, summarize } from '../../knowledge/prime-labels.js';

interface Sample { cwd: string; prompt: string; session: string }

export function samplePrompts(sessionsToScan: number, perSession: number): Sample[] {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files: Array<{ f: string; mtime: number }> = [];
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      files.push({ f: full, mtime: fs.statSync(full).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: Sample[] = [];
  for (const { f } of files.slice(0, sessionsToScan)) {
    const prompts: Sample[] = [];
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      try {
        const o = JSON.parse(line) as { type?: string; cwd?: string; message?: { content?: unknown } };
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : '';
        if (o.type === 'user' && text.trim().length >= 25 && !isSystemNotificationPrompt(text) && !text.startsWith('Caveat:')) {
          prompts.push({ cwd: o.cwd ?? '', prompt: text.slice(0, 1200), session: path.basename(f, '.jsonl') });
        }
      } catch { /* skip malformed line */ }
    }
    if (prompts.length === 0) continue;
    const step = Math.max(1, Math.floor(prompts.length / perSession));
    for (let i = 0; i < prompts.length && out.filter(s => s.session === prompts[0].session).length < perSession; i += step) out.push(prompts[i]);
  }
  return out;
}

export async function cmdEvalPrime(args: string[]): Promise<void> {
  if (args.includes('--tool')) return (await import('./eval-prime-tool.js')).cmdEvalPrimeTool(args);
  const n = Number(args.find(a => a.startsWith('--sessions='))?.split('=')[1] ?? 30);
  const per = Number(args.find(a => a.startsWith('--per-session='))?.split('=')[1] ?? 3);
  const cfg = { ...(await readKnowledgeConfig()), prime: true };
  const samples = samplePrompts(n, per);

  const labels = loadLabels();
  const doLabel = args.includes('--label');
  const judge = doLabel ? new ClaudeCliSynthesizer({ defaultModel: cfg.synth.defaultModel, models: cfg.synth.models }) : null;
  const fires: Array<{ key: string }> = [];
  let judged = 0;
  let fired = 0, two = 0;
  const byRef = new Map<string, number>();
  const rows: string[] = [];
  for (const s of samples) {
    let emb: number[];
    try { emb = await embed(s.prompt); } catch { continue; }
    const trace: PrimeTrace[] = [];
    const p = await computePrime({
      promptEmbedding: emb, promptText: s.prompt, cwd: s.cwd || process.cwd(), sessionId: `eval-${s.session}`,
      turn: 1, trigger: 'first-prompt', config: cfg, dryRun: true, trace,
    });
    if (p) {
      fired++;
      if (p.refs.length > 1) two++;
      for (const r of p.refs) byRef.set(r, (byRef.get(r) ?? 0) + 1);
      const key = labelKey(s.prompt, p.refs);
      fires.push({ key });
      if (judge && !labels[key]) {
        try {
          const l = await judgePrime(judge, s.prompt, p.additionalContext);
          if (l) { labels[key] = l; judged++; saveLabels(labels); }
        } catch (err) { process.stderr.write(`judge failed: ${err}\n`); }
      }
      const mark = labels[key] ? labels[key].verdict.slice(0, 4).toUpperCase() : '----';
      rows.push(`PRIME ${mark} ${p.refs.join(' + ').padEnd(54)} sim=${p.topScore.toFixed(2)}  ← ${s.prompt.replace(/\s+/g, ' ').slice(0, 90)}`);
    } else if (trace.length > 0) {
      rows.push(`skip   ${trace[0].ref.padEnd(54)} sim=${trace[0].similarity.toFixed(2)}  (${trace[0].verdict})  ← ${s.prompt.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—');
  process.stdout.write(`eval-prime · ${samples.length} real prompts from ${n} recent sessions (read-only, each judged as a trigger turn)\n`);
  process.stdout.write(`prime fires on ${fired}/${samples.length} (${pct(fired, samples.length)}) · second item rides along on ${two}/${fired} primes (${pct(two, fired)})\n`);
  const ps = summarize(fires, labels);
  if (ps.labelled > 0) {
    process.stdout.write(`precision (judged by Claude, fixed labels in ${'tests/fixtures/prime-labels.json'}): helpful ${ps.helpful}/${ps.labelled} (${pct(ps.helpful, ps.labelled)}) · neutral ${ps.neutral} · irrelevant ${ps.irrelevant} (${pct(ps.irrelevant, ps.labelled)})${ps.unlabelled ? ` · ${ps.unlabelled} fires not yet labelled (run with --label)` : ''}${judged ? ` · judged ${judged} new` : ''}\n`);
  } else if (fires.length) {
    process.stdout.write(`precision: no labels yet — run \`johnny eval-prime --label\` to have Claude judge ${fires.length} fires\n`);
  }
  process.stdout.write(`most-primed: ${[...byRef.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${r} ×${c}`).join(', ') || '—'}\n\n`);
  if (args.includes('--verbose')) process.stdout.write(rows.join('\n') + '\n');
  else process.stdout.write(rows.filter(r => r.startsWith('PRIME')).slice(0, 25).join('\n') + '\n(--verbose shows the skipped prompts too)\n');
}
