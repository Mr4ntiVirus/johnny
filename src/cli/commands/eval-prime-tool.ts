// johnny eval-prime --tool — replays real Bash commands from past sessions through the tool-time
// priming decision (what the opt-in PreToolUse hook would have done), under the production rules:
// the trivial-command filter, one scan per minute per session, once per context epoch (reset at
// compaction). Read-only: nothing is written to the store. Labels go to a fixture keyed by hash.
//
// Three query modes are compared on the same commands:
//   command  the command text (PreToolUse as built)
//   error    the error text of a FAILED command (a PostToolUseFailure candidate)
//   both     command + the start of the error
//
// Privacy: embedding and priming are local, so every call is evaluated. A call is only SENT to the
// judge (and only then stored, as a hash) if neither its command, result nor request looks like it
// carries a credential; those calls are counted separately and excluded from precision.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { embed } from '../../utils/llm.js';
import { readKnowledgeConfig } from '../../knowledge/config.js';
import { computePrime } from '../../knowledge/prime.js';
import { shouldConsiderCommand, TOOL_SCAN_MIN_INTERVAL_MS } from '../pre-tool.js';
import { isSystemNotificationPrompt } from '../evaluate.js';
import { containsSecret, redactSecrets } from '../../knowledge/redact.js';
import { ClaudeCliSynthesizer } from '../../knowledge/synth.js';
import { judgeToolPrime, labelKey, loadLabels, saveLabels, summarize, toolLabelsPath } from '../../knowledge/prime-labels.js';

export interface BashCall {
  session: string;
  cwd: string;
  atMs: number;
  command: string;
  failed: boolean;
  /** First part of the tool result (the error text when failed). */
  resultText: string;
  /** The nearest preceding genuine user prompt. */
  request: string;
  /** Increments at every compaction boundary within the session. */
  epoch: number;
}

export type QueryMode = 'command' | 'error' | 'both';

const RESULT_CHARS = 400;
const REQUEST_CHARS = 600;
const SENSITIVE_ASSIGNMENT = /(?:^|[\s;&|(])[A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*\S/i;

/** redactSecrets misses env-style assignments such as PGPASSWORD=… and AWS_SECRET_ACCESS_KEY=…, so check both. */
export function looksSensitive(text: string): boolean {
  return containsSecret(text) || SENSITIVE_ASSIGNMENT.test(text);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
  }
  return '';
}

/** Pairs every Bash tool_use in one session transcript with its result, request and epoch. Sidechain (subagent) records are excluded and counted. */
export function extractBashCalls(jsonl: string, session: string): { calls: BashCall[]; sidechain: number } {
  const pending = new Map<string, BashCall>();
  const calls: BashCall[] = [];
  let sidechain = 0;
  let request = '';
  let epoch = 0;
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let o: Record<string, any>;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'compact_boundary') { epoch++; continue; }
    const content = o.message?.content;
    if (o.type === 'user') {
      if (o.isSidechain) continue;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          const call = pending.get(b.tool_use_id);
          if (!call) continue;
          call.failed = b.is_error === true;
          call.resultText = blockText(b.content).trim().slice(0, RESULT_CHARS);
          pending.delete(b.tool_use_id);
        }
      }
      if (o.isMeta || o.isCompactSummary) continue;
      const text = blockText(content).trim();
      if (text && !isSystemNotificationPrompt(text) && !text.startsWith('Caveat:') && !(Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result'))) {
        request = text.slice(0, REQUEST_CHARS);
      }
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.input?.command !== 'string') continue;
        if (o.isSidechain) { sidechain++; continue; }
        const atMs = Date.parse(o.timestamp);
        if (!Number.isFinite(atMs)) continue;
        const call: BashCall = { session, cwd: o.cwd ?? '', atMs, command: b.input.command, failed: false, resultText: '', request, epoch };
        pending.set(b.id, call);
        calls.push(call);
      }
    }
  }
  return { calls, sidechain };
}

export interface ReplayDecision { refs: string[]; topScore: number; digest: string }
export interface Fire { call: BashCall; query: string; decision: ReplayDecision }
export interface ReplayStats {
  bash: number;          // every Bash call seen
  eligible: number;      // calls this mode can consider (all for command; failed only for error/both)
  trivial: number;       // dropped by the production filter
  throttled: number;     // dropped by the per-session scan limiter
  scans: number;         // reached the matcher
  fires: Fire[];
}

/** Query text for a call under a mode, or null when the mode does not consider it. */
export function queryFor(call: BashCall, mode: QueryMode): string | null {
  if (mode === 'command') return call.command;
  if (!call.failed || !call.resultText) return null;
  return mode === 'error' ? call.resultText : `${call.command}\n${call.resultText.slice(0, 300)}`;
}

/**
 * Walks the calls chronologically and applies the production rules. `decide` is the matcher (computePrime in
 * real use) and receives the session's surfaced map for the current epoch, which the replay maintains.
 */
export async function replayCalls(
  calls: BashCall[], mode: QueryMode, throttleMs: number,
  decide: (call: BashCall, query: string, surfaced: Record<string, number>, turn: number) => Promise<ReplayDecision | null>,
): Promise<ReplayStats> {
  const stats: ReplayStats = { bash: 0, eligible: 0, trivial: 0, throttled: 0, scans: 0, fires: [] };
  const lastScan = new Map<string, number>();
  const surfacedBySession = new Map<string, { epoch: number; map: Record<string, number> }>();
  let turn = 0;
  for (const call of calls) {
    stats.bash++;
    const query = queryFor(call, mode);
    if (query === null) continue;
    stats.eligible++;
    if (!shouldConsiderCommand(call.command)) { stats.trivial++; continue; }
    const prev = lastScan.get(call.session);
    if (throttleMs > 0 && prev !== undefined && call.atMs - prev < throttleMs) { stats.throttled++; continue; }
    lastScan.set(call.session, call.atMs);
    stats.scans++;
    let state = surfacedBySession.get(call.session);
    if (!state || state.epoch !== call.epoch) { state = { epoch: call.epoch, map: {} }; surfacedBySession.set(call.session, state); }
    const decision = await decide(call, query, state.map, ++turn);
    if (decision) {
      stats.fires.push({ call, query, decision });
      for (const ref of decision.refs) state.map[ref] = turn;
    }
  }
  return stats;
}

export const isSensitiveCall = (c: BashCall): boolean =>
  looksSensitive(c.command) || looksSensitive(c.resultText) || looksSensitive(c.request);

/** Label key of a fire: the text that triggered the prime plus the refs it primed, so a failure-text or combined fire never reuses a verdict given for the command alone. */
export const fireKey = (f: Fire): string => labelKey(f.query, f.decision.refs);

/**
 * Deterministic stratified sample for judging: round-robin across similarity bands (band i starts at edges[i]),
 * each band ordered by label key. Keys are hashes, so the order is unbiased by session or time, and a re-run
 * extends the sample instead of repeating it.
 */
export function stratifiedSample<T extends { key: string; score: number }>(items: T[], edges: number[], budget: number): T[] {
  const sorted = [...edges].sort((a, b) => a - b);
  const bands: T[][] = sorted.map(() => []);
  for (const it of items) {
    let b = 0;
    for (let i = 0; i < sorted.length; i++) if (it.score >= sorted[i]) b = i;
    bands[b].push(it);
  }
  for (const b of bands) b.sort((x, y) => x.key.localeCompare(y.key));
  const out: T[] = [];
  for (let round = 0; out.length < budget; round++) {
    let took = false;
    for (const b of bands) {
      if (round < b.length && out.length < budget) { out.push(b[round]); took = true; }
    }
    if (!took) break;
  }
  return out;
}

function recentSessionFiles(count: number): Array<{ file: string; session: string }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files: Array<{ file: string; mtime: number }> = [];
  for (const proj of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.jsonl')) files.push({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, count).map(f => ({ file: f.file, session: path.basename(f.file, '.jsonl') }));
}

const flag = (args: string[], name: string): string | undefined => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const pctOf = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');

interface FloorRun { mode: QueryMode; floor: number; throttleMs: number; stats: ReplayStats }

export async function cmdEvalPrimeTool(args: string[]): Promise<void> {
  const sessions = Number(flag(args, 'sessions') ?? 30);
  const floors = (flag(args, 'floors') ?? '0.53,0.58,0.63,0.68').split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const modeArg = flag(args, 'mode') ?? 'command';
  const modes: QueryMode[] = modeArg === 'all' ? ['command', 'error', 'both'] : [modeArg as QueryMode];
  if (modes.some(m => !['command', 'error', 'both'].includes(m))) throw new Error(`--mode must be command|error|both|all (got ${modeArg})`);
  const maxJudge = Number(flag(args, 'max-judge') ?? 120);
  const verbose = args.includes('--verbose');
  const cfg = { ...(await readKnowledgeConfig()), prime: true };

  const calls: BashCall[] = [];
  let sidechain = 0;
  const files = recentSessionFiles(sessions);
  for (const { file, session } of files) {
    const r = extractBashCalls(fs.readFileSync(file, 'utf-8'), session);
    calls.push(...r.calls);
    sidechain += r.sidechain;
  }
  calls.sort((a, b) => a.session.localeCompare(b.session) || a.atMs - b.atMs);

  const embedCache = new Map<string, number[] | null>();
  const embedCached = async (text: string): Promise<number[] | null> => {
    const key = text.slice(0, 2000);
    if (!embedCache.has(key)) embedCache.set(key, await embed(key).catch(() => null));
    return embedCache.get(key) ?? null;
  };

  // 1. Replay every mode x floor once (embeddings are cached across floors).
  const runs: FloorRun[] = [];
  for (const mode of modes) {
    const throttleMs = flag(args, 'throttle') !== undefined ? Number(flag(args, 'throttle')) * 1000 : mode === 'command' ? TOOL_SCAN_MIN_INTERVAL_MS : 0;
    for (const floor of floors) {
      const floorCfg = { ...cfg, primeToolSimilarity: floor };
      const stats = await replayCalls(calls, mode, throttleMs, async (call, query, surfaced, turn) => {
        const emb = await embedCached(query);
        if (!emb) return null;
        const p = await computePrime({
          promptEmbedding: emb, promptText: query, cwd: call.cwd || process.cwd(), sessionId: `eval-tool-${call.session}`,
          turn, trigger: 'tool', config: floorCfg, dryRun: true, surfaced,
        });
        return p ? { refs: p.refs, topScore: p.topScore, digest: p.additionalContext } : null;
      });
      runs.push({ mode, floor, throttleMs, stats });
    }
  }

  // 2. Judge a stratified sample of unlabelled fires. Sensitive calls are evaluated above but never sent or stored.
  const labelFile = toolLabelsPath();
  const labels = loadLabels(labelFile);
  let judged = 0;
  if (args.includes('--label')) {
    const judge = new ClaudeCliSynthesizer({ defaultModel: cfg.synth.defaultModel, models: cfg.synth.models });
    const pool = new Map<string, { key: string; score: number; fire: Fire }>();
    for (const r of runs) {
      for (const fire of r.stats.fires) {
        if (isSensitiveCall(fire.call)) continue;
        const key = fireKey(fire);
        if (!labels[key] && !pool.has(key)) pool.set(key, { key, score: fire.decision.topScore, fire });
      }
    }
    for (const { key, fire } of stratifiedSample([...pool.values()], floors, maxJudge)) {
      const c = fire.call;
      const verdict = await judgeToolPrime(judge, {
        request: redactSecrets(c.request), command: redactSecrets(c.command), result: redactSecrets(c.resultText), failed: c.failed,
      }, fire.decision.digest).catch(err => { process.stderr.write(`judge failed: ${err}\n`); return null; });
      if (verdict) { labels[key] = { verdict: verdict.verdict, reason: '' }; judged++; saveLabels(labels, labelFile); }
    }
  }

  // 3. Report.
  const keyOf = (f: Fire) => ({ key: fireKey(f) });
  const distinctJudged = (fires: Fire[]) => new Set(fires.map(fireKey).filter(k => labels[k])).size;
  const out = (line: string) => process.stdout.write(line + '\n');
  out(`eval-prime --tool · ${calls.length} Bash calls (${calls.filter(c => c.failed).length} failed) from ${files.length} recent sessions; ${sidechain} subagent calls excluded`);
  out('read-only; production rules simulated: trivial filter, per-session scan throttle, once per context epoch (reset at compaction)');
  for (const mode of modes) {
    const modeRuns = runs.filter(r => r.mode === mode);
    out(`\nmode=${mode}  throttle=${modeRuns[0].throttleMs / 1000}s  (command = PreToolUse as built · error = failed commands only, error text · both = command + error start)`);
    out('  floor  eligible  trivial  throttled  scans  fires  /100 eligible  fires/scan  | judged  distinct  helpful  neutral  irrelevant  | skipped-sensitive');
    for (const r of modeRuns) {
      const usable = r.stats.fires.filter(f => !isSensitiveCall(f.call));
      const s = summarize(usable.map(keyOf), labels);
      out(`  ${r.floor.toFixed(2)}   ${String(r.stats.eligible).padStart(8)}  ${String(r.stats.trivial).padStart(7)}  ${String(r.stats.throttled).padStart(9)}  ${String(r.stats.scans).padStart(5)}  ${String(r.stats.fires.length).padStart(5)}  ${((100 * r.stats.fires.length) / Math.max(1, r.stats.eligible)).toFixed(1).padStart(12)}  ${pctOf(r.stats.fires.length, r.stats.scans).padStart(10)}  | ${String(s.labelled).padStart(6)}  ${String(distinctJudged(usable)).padStart(8)}  ${pctOf(s.helpful, s.labelled).padStart(7)}  ${pctOf(s.neutral, s.labelled).padStart(7)}  ${pctOf(s.irrelevant, s.labelled).padStart(10)}  | ${String(r.stats.fires.length - usable.length).padStart(17)}`);
    }
    const low = modeRuns[0];
    out(`\n  precision by top similarity, fires at the lowest floor (${low.floor.toFixed(2)}):`);
    out('  band           fires  judged  distinct  helpful  neutral  irrelevant');
    floors.forEach((lo, i) => {
      const hi = floors[i + 1] ?? Infinity;
      const inBand = low.stats.fires.filter(f => !isSensitiveCall(f.call) && f.decision.topScore >= lo && f.decision.topScore < hi);
      const s = summarize(inBand.map(keyOf), labels);
      out(`  [${lo.toFixed(2)}, ${hi === Infinity ? ' inf' : hi.toFixed(2)})  ${String(inBand.length).padStart(5)}  ${String(s.labelled).padStart(6)}  ${String(distinctJudged(inBand)).padStart(8)}  ${pctOf(s.helpful, s.labelled).padStart(7)}  ${pctOf(s.neutral, s.labelled).padStart(7)}  ${pctOf(s.irrelevant, s.labelled).padStart(10)}`);
    });
    const byRef = new Map<string, number>();
    for (const f of low.stats.fires) for (const ref of f.decision.refs) byRef.set(ref, (byRef.get(ref) ?? 0) + 1);
    out(`  distinct refs primed: ${byRef.size} · most-primed: ${[...byRef.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} ×${n}`).join(', ') || '—'}`);
    if (verbose) {
      out('');
      for (const f of low.stats.fires.slice(0, 40)) {
        const l = labels[fireKey(f)];
        out(`  ${(l ? l.verdict.slice(0, 4).toUpperCase() : '----')} ${f.decision.refs.join('+').padEnd(40)} sim=${f.decision.topScore.toFixed(2)} ← ${redactSecrets(f.call.command).replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  const total = summarize(Object.keys(labels).map(key => ({ key })), labels);
  out(`\nlabels in ${path.relative(process.cwd(), labelFile) || labelFile}: ${total.labelled} (helpful ${total.helpful} · neutral ${total.neutral} · irrelevant ${total.irrelevant})${judged ? ` · judged ${judged} new this run (cap ${maxJudge})` : ''}`);
  if (!args.includes('--label')) out('judged columns reflect labels from earlier runs only; add --label to judge a stratified sample (capped by --max-judge).');
}
