// johnny eval-recommend — measures PRECISION of the legacy memory hints (recommend_memory, offer,
// suggest_memories) on real past suggestions, by raw cosine band, so a threshold change is scored against
// fixed labels instead of guesses. Read-only except the labels fixture.
//
// Each hint_telemetry row records the session, time, suggested memory ids and raw cosine (top_score). The
// prompt that triggered it is recovered from the session JSONL (latest user line at or before emitted_at).
// A judge model (Claude, subscription CLI) rates whether the memory's digest would have helped that prompt.
// Labels are keyed by hash(prompt)+memory id, so prompt text never lands in the repo.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '../../store/db-client.js';
import { getMemory } from '../../store/db/memories.js';
import { readKnowledgeConfig } from '../../knowledge/config.js';
import { ClaudeCliSynthesizer } from '../../knowledge/synth.js';
import { labelKey, loadLabels, saveLabels, judgePrime, type PrimeLabels } from '../../knowledge/prime-labels.js';
import { isSystemNotificationPrompt } from '../evaluate.js';
import { listMemories } from '../../store/db/memories.js';
import { rankBySimilarity } from '../../engine/embedder.js';
import { memoryRecordToNode } from '../../store/db/graph.js';

export const recommendLabelsPath = (): string =>
  process.env.JOHNNY_RECOMMEND_LABELS ?? path.join(process.cwd(), 'tests', 'fixtures', 'recommend-labels.json');

export const BANDS: Array<[number, number]> = [[0, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75], [0.75, 0.8], [0.8, 0.85], [0.85, 1.01]];

interface HintRow { session_id: string | null; emitted_at: string; form: string; suggested_memory_ids: string | null; top_score: number | null; prompt_excerpt: string | null }
export interface Row { session: string; at: string; form: string; memoryId: string; cosine: number; prompt: string }

// User text from a JSONL message: a string, or the text blocks of a content array (tool_result blocks and
// harness <system-reminder> blocks are not what the user typed, so they are dropped).
export function userText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b): b is { type: string; text: string } => !!b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text).filter(t => !t.trimStart().startsWith('<system-reminder>')).join('\n').trim();
}

// The user prompt that triggered a hint: the typed user line nearest to `at` (within windowMs either side:
// the hook fires just before or after Claude Code stamps the line). Older prompts are often gone because
// Johnny's trims/swaps rewrite the session file, so many historic hints cannot be recovered.
export function promptAt(sessionFile: string, at: string, windowMs = 60_000): string | null {
  const t = Date.parse(at);
  let best: { d: number; text: string } | null = null;
  for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const o = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
      const text = userText(o.message?.content);
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (o.type !== 'user' || !text || Number.isNaN(ts) || Math.abs(ts - t) > windowMs) continue;
      if (isSystemNotificationPrompt(text) || text.startsWith('Caveat:')) continue;
      const d = Math.abs(ts - t);
      if (!best || d < best.d) best = { d, text };
    } catch { /* skip malformed line */ }
  }
  return best ? best.text : null;
}

function indexSessions(): Map<string, string> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const m = new Map<string, string>();
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) m.set(f.slice(0, -6), path.join(dir, f));
  }
  return m;
}

export async function loadRows(since: string, forms: string[]): Promise<Row[]> {
  const sessions = indexSessions();
  const hints = await query<HintRow>(
    `SELECT session_id, emitted_at, form, suggested_memory_ids, top_score, prompt_excerpt FROM hint_telemetry
     WHERE emitted_at >= ? AND form IN (${forms.map(() => '?').join(',')}) AND top_score IS NOT NULL ORDER BY emitted_at DESC`,
    [since, ...forms]);
  const out: Row[] = [];
  for (const h of hints) {
    if (!h.suggested_memory_ids) continue;
    const file = h.session_id ? sessions.get(h.session_id) : undefined;
    if (!h.prompt_excerpt && !file) continue;
    let ids: string[] = [];
    try { ids = JSON.parse(h.suggested_memory_ids) as string[]; } catch { continue; }
    if (ids.length !== 1) continue;                    // blends (suggest_memories) can't be judged as one memory
    // Prefer the prompt stored with the hint (recorded since 2026-10-13); old rows fall back to the session file.
    const prompt = h.prompt_excerpt || (file ? promptAt(file, h.emitted_at) : null);
    if (prompt) out.push({ session: h.session_id!, at: h.emitted_at, form: h.form, memoryId: ids[0], cosine: h.top_score!, prompt });
  }
  return out;
}

export interface SweepRow { cutoff: number; kept: number; helpful: number; precision: number; recall: number }

// For each candidate cosine cutoff: how many labelled hints survive, precision (helpful/kept) and recall
// (helpful kept / all helpful). Neutral and irrelevant both count as not-worth-injecting.
export function sweep(rows: Array<{ cosine: number; helpful: boolean }>, cutoffs: number[]): SweepRow[] {
  const totalHelpful = rows.filter(r => r.helpful).length;
  return cutoffs.map(c => {
    const kept = rows.filter(r => r.cosine >= c);
    const helpful = kept.filter(r => r.helpful).length;
    return { cutoff: c, kept: kept.length, helpful, precision: kept.length ? helpful / kept.length : 0, recall: totalHelpful ? helpful / totalHelpful : 0 };
  });
}


// --mine: build a labelled set WITHOUT relying on hint history (most old prompts are unrecoverable from hints).
// Samples real typed prompts (with timestamps) from recent sessions, finds the memory the hook would have matched
// (top raw cosine among memories that existed BEFORE the prompt, so a session cannot match its own snapshot),
// stratified across cosine bands so the judge budget is spread over the range the cutoff lives in.
export interface MinedRow { cosine: number; prompt: string; memoryId: string }

export async function minePrompts(sessionsToScan: number, perSession: number, perBand: number): Promise<{ rows: MinedRow[]; population: number[] }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files: Array<{ f: string; mtime: number }> = [];
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push({ f: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const samples: Array<{ prompt: string; at: string }> = [];
  for (const { f } of files.slice(0, sessionsToScan)) {
    const prompts: Array<{ prompt: string; at: string }> = [];
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      try {
        const o = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: unknown } };
        const text = userText(o.message?.content);
        if (o.type === 'user' && o.timestamp && text.length >= 25 && !isSystemNotificationPrompt(text) && !text.startsWith('Caveat:') && !text.startsWith('[johnny]')) {
          prompts.push({ prompt: text.slice(0, 1200), at: o.timestamp });
        }
      } catch { /* skip */ }
    }
    const step = Math.max(1, Math.floor(prompts.length / perSession));
    for (let i = 0, n = 0; i < prompts.length && n < perSession; i += step, n++) samples.push(prompts[i]);
  }
  const records = await listMemories({ limit: 20000 });
  const nodes = records.map(r => memoryRecordToNode(r, []));
  const out: MinedRow[] = [];
  const bandCount = BANDS.map(() => 0);
  const population = BANDS.map(() => 0);
  for (const s of samples) {
    const eligible = nodes.filter(m => m.createdAt < s.at);
    let top;
    try { top = (await rankBySimilarity(s.prompt, eligible, 1))[0]; } catch { continue; }
    if (!top) continue;
    const b = BANDS.findIndex(([lo, hi]) => top.similarity >= lo && top.similarity < hi);
    if (b < 0) continue;
    population[b]++;                       // unstratified: how often each band occurs on real prompts
    if (bandCount[b] >= perBand) continue;
    bandCount[b]++;
    out.push({ cosine: top.similarity, prompt: s.prompt, memoryId: top.memory.id });
  }
  return { rows: out, population };
}

export async function cmdEvalRecommend(args: string[]): Promise<void> {
  const days = Number(args.find(a => a.startsWith('--days='))?.split('=')[1] ?? 45);
  const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 80);
  const doLabel = args.includes('--label');
  const forms = (args.find(a => a.startsWith('--forms='))?.split('=')[1] ?? 'recommend_memory,offer').split(',');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const file = recommendLabelsPath();
  const labels: PrimeLabels = loadLabels(file);

  const mine = args.includes('--mine');
  const perBandMine = Number(args.find(a => a.startsWith('--per-band='))?.split('=')[1] ?? 30);
  let population: number[] | null = null;
  let rows: Row[];
  const pairsFile = args.find(a => a.startsWith('--pairs='))?.split('=')[1];
  if (mine && pairsFile && fs.existsSync(pairsFile)) {
    // Fixed (prompt, memory) pairs from an earlier run, so before/after judging compares the same cases.
    population = null;
    rows = (JSON.parse(fs.readFileSync(pairsFile, 'utf-8')) as MinedRow[]).map(x => ({ session: 'mined', at: '', form: 'mined', memoryId: x.memoryId, cosine: x.cosine, prompt: x.prompt }));
  } else if (mine) {
    const m = await minePrompts(Number(args.find(a => a.startsWith('--sessions='))?.split('=')[1] ?? 60), 12, perBandMine);
    population = m.population;
    rows = m.rows.map(x => ({ session: 'mined', at: '', form: 'mined', memoryId: x.memoryId, cosine: x.cosine, prompt: x.prompt }));
  } else rows = await loadRows(since, forms);
  // Stratify the sample across bands so the weak band is not drowned out by the bulk.
  const perBand = mine ? 1e9 : Math.max(1, Math.floor(limit / BANDS.length));
  const sample: Row[] = [];
  for (const [lo, hi] of BANDS) sample.push(...rows.filter(r => r.cosine >= lo && r.cosine < hi).slice(0, perBand));

  const cfg = await readKnowledgeConfig();
  const judge = doLabel ? new ClaudeCliSynthesizer({ defaultModel: cfg.synth.defaultModel, models: cfg.synth.models }) : null;
  let judged = 0;
  const scored: Array<{ cosine: number; helpful: boolean; verdict: string }> = [];
  let unlabelled = 0;
  for (const r of sample) {
    const key = labelKey(r.prompt, [r.memoryId]);
    if (!labels[key] && judge) {
      const mem = await getMemory(r.memoryId);
      if (!mem) continue;
      try {
        const digest = `${mem.title}\n${mem.summary ?? ''}`;
        const l = await judgePrime(judge, r.prompt, digest);
        if (l) { labels[key] = l; judged++; saveLabels(labels, file); }
      } catch (err) { process.stderr.write(`judge failed: ${err}\n`); }
    }
    const l = labels[key];
    if (!l) { unlabelled++; continue; }
    scored.push({ cosine: r.cosine, helpful: l.verdict === 'helpful', verdict: l.verdict });
  }

  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  process.stdout.write(`eval-recommend · ${rows.length} real hints (${forms.join('+')}, last ${days}d) · sampled ${sample.length} across cosine bands · labelled ${scored.length}${unlabelled ? ` · ${unlabelled} unlabelled (run with --label)` : ''}${judged ? ` · judged ${judged} new` : ''}\n\n`);
  process.stdout.write('raw cosine band   n   helpful  neutral  irrelevant   precision\n');
  for (const [lo, hi] of BANDS) {
    const b = scored.filter(s => s.cosine >= lo && s.cosine < hi);
    const h = b.filter(s => s.verdict === 'helpful').length, n = b.filter(s => s.verdict === 'neutral').length, i = b.filter(s => s.verdict === 'irrelevant').length;
    process.stdout.write(`${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}  ${String(b.length).padStart(5)}  ${String(h).padStart(7)}  ${String(n).padStart(7)}  ${String(i).padStart(10)}   ${pct(h, b.length).padStart(6)}\n`);
  }
  process.stdout.write('\ncutoff sweep (keep hints with raw cosine >= cutoff):\ncutoff  kept  precision  recall-of-helpful\n');
  for (const s of sweep(scored, [0.55, 0.6, 0.62, 0.65, 0.68, 0.7, 0.72, 0.75])) {
    process.stdout.write(`${s.cutoff.toFixed(2)}   ${String(s.kept).padStart(4)}   ${pct(s.helpful, s.kept).padStart(7)}   ${pct(s.helpful, scored.filter(x => x.helpful).length).padStart(7)}\n`);
  }
  if (population) {
    const N = population.reduce((a, b) => a + b, 0);
    process.stdout.write(`\npopulation-weighted estimate over ${N} real prompts (per-band precision from the judged sample):\n`);
    process.stdout.write('band            share-of-prompts  precision(helpful)  precision(helpful+neutral)\n');
    const prec = BANDS.map(([lo, hi]) => {
      const b = scored.filter(x => x.cosine >= lo && x.cosine < hi);
      return { n: b.length, h: b.filter(x => x.verdict === 'helpful').length, hn: b.filter(x => x.verdict !== 'irrelevant').length };
    });
    BANDS.forEach(([lo, hi], i) => process.stdout.write(`${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}   ${pct(population![i], N).padStart(10)}        ${pct(prec[i].h, prec[i].n).padStart(8)} (n=${prec[i].n})       ${pct(prec[i].hn, prec[i].n).padStart(8)}\n`));
    process.stdout.write('\ncutoff  prompts-hinted  helpful-hints/100-prompts  wrong-hints/100-prompts  precision\n');
    for (const c of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) {
      let hinted = 0, helpful = 0;
      BANDS.forEach(([lo], i) => { if (lo >= c) { hinted += population![i]; helpful += population![i] * (prec[i].n ? prec[i].h / prec[i].n : 0); } });
      process.stdout.write(`${c.toFixed(2)}   ${pct(hinted, N).padStart(8)}      ${(100 * helpful / N).toFixed(1).padStart(10)}               ${(100 * (hinted - helpful) / N).toFixed(1).padStart(10)}        ${pct(helpful, hinted).padStart(6)}\n`);
    }
  }
}
