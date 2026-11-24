// johnny eval-recall — read-only retrieval-quality harness.
//
// Replays recent real queries (recall_telemetry) plus fixed acceptance probes
// through the actual recall pipeline (selectRecall: no telemetry, no Hebbian
// reinforcement, no retrieval-count bumps) and reports:
//   - duplicate-tile rate (tiles whose text duplicates another tile in the same answer)
//   - distinct memories / distinct summaries per answer
//   - share of answers containing at least one knowledge tile (model/observation/fact)
//   - acceptance-probe pass/fail
// Run before and after each phase and diff the JSON (`--out report.json`).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '../../store/db-client.js';
import { selectRecall } from '../../mcp/index.js';
import { contentHash } from '../../utils/content-hash.js';
import * as memoriesDb from '../../store/db/memories.js';

export interface Probe { name: string; query: string; mustMatch: RegExp }

// Acceptance probes are facts from YOUR history that are not in always-loaded context
// (CLAUDE.md etc.), so passing them proves retrieval, not priming. Define them in
// ~/.johnny/probes.json as [{ "name": "...", "query": "...", "mustMatch": "regex" }].
export function loadAcceptanceProbes(): Probe[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.johnny', 'probes.json'), 'utf-8')) as
      Array<{ name: string; query: string; mustMatch: string }>;
    return raw.map(p => ({ name: p.name, query: p.query, mustMatch: new RegExp(p.mustMatch, 'i') }));
  } catch {
    return [];
  }
}
export const ACCEPTANCE_PROBES: Probe[] = loadAcceptanceProbes();

export interface QueryReport {
  query: string;
  tiles: number;
  distinctTexts: number;
  duplicateTileRate: number;
  distinctMemories: number;
  distinctSummaries: number;
  knowledgeTiles: number;
  topTiles: Array<{ chunkId: string; score: number; head: string }>;
}

export interface EvalReport {
  generatedAt: string;
  replayed: number;
  answered: number;
  meanDuplicateTileRate: number;
  meanDistinctMemories: number;
  meanDistinctSummaries: number;
  knowledgeAnswerShare: number;
  probes: Array<{ name: string; query: string; passed: boolean; tiles: number }>;
  queries: QueryReport[];
}

const isKnowledgeChunkId = (id: string) => /^(model|obs|fact):/.test(id);

async function evalOne(q: string): Promise<{ report: QueryReport; texts: string[] }> {
  const sel = await selectRecall({ query: q, limit: 8 });
  if ('empty' in sel) {
    return { report: { query: q, tiles: 0, distinctTexts: 0, duplicateTileRate: 0, distinctMemories: 0, distinctSummaries: 0, knowledgeTiles: 0, topTiles: [] }, texts: [] };
  }
  const texts = sel.selected.map(t => t.text);
  const hashes = texts.map(t => contentHash(t));
  const summaries = new Set<string>();
  for (const id of new Set(sel.selected.map(t => t.memoryId))) {
    const m = await memoriesDb.getMemory(id).catch(() => null);
    summaries.add(contentHash(m?.summary ?? id));
  }
  const distinct = new Set(hashes).size;
  return {
    texts,
    report: {
      query: q,
      tiles: texts.length,
      distinctTexts: distinct,
      duplicateTileRate: texts.length ? 1 - distinct / texts.length : 0,
      distinctMemories: new Set(sel.selected.map(t => t.memoryId)).size,
      distinctSummaries: summaries.size,
      knowledgeTiles: sel.selected.filter(t => isKnowledgeChunkId(t.chunkId)).length,
      topTiles: sel.selected.slice(0, 3).map(t => ({ chunkId: t.chunkId, score: Math.round(t.score * 1000) / 1000, head: t.text.replace(/\s+/g, ' ').slice(0, 80) })),
    },
  };
}

export async function runEvalRecall(opts: { replay: number }): Promise<EvalReport> {
  const rows = await query<{ query: string }>(
    `SELECT query FROM recall_telemetry WHERE query IS NOT NULL AND TRIM(query) != ''
     GROUP BY query ORDER BY MAX(called_at) DESC LIMIT ?`, [opts.replay]);
  const queries = rows.map(r => r.query);

  const reports: QueryReport[] = [];
  for (const q of queries) reports.push((await evalOne(q)).report);

  const probes: EvalReport['probes'] = [];
  for (const p of loadAcceptanceProbes()) {
    const { report, texts } = await evalOne(p.query);
    probes.push({ name: p.name, query: p.query, passed: texts.some(t => p.mustMatch.test(t)), tiles: report.tiles });
  }

  const answered = reports.filter(r => r.tiles > 0);
  const mean = (f: (r: QueryReport) => number) => answered.length ? answered.reduce((a, r) => a + f(r), 0) / answered.length : 0;
  return {
    generatedAt: new Date().toISOString(),
    replayed: reports.length,
    answered: answered.length,
    meanDuplicateTileRate: mean(r => r.duplicateTileRate),
    meanDistinctMemories: mean(r => r.distinctMemories),
    meanDistinctSummaries: mean(r => r.distinctSummaries),
    knowledgeAnswerShare: answered.length ? answered.filter(r => r.knowledgeTiles > 0).length / answered.length : 0,
    probes,
    queries: reports,
  };
}

export async function cmdEvalRecall(args: string[]): Promise<void> {
  const replay = Number((args.find(a => a.startsWith('--replay='))?.split('=')[1]) ?? 40);
  const out = args.find(a => a.startsWith('--out='))?.split('=')[1];
  const report = await runEvalRecall({ replay });
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `eval-recall · ${report.generatedAt}`,
    `replayed ${report.replayed} queries · answered ${report.answered}`,
    `duplicate-tile rate  ${pct(report.meanDuplicateTileRate)}`,
    `distinct memories/answer  ${report.meanDistinctMemories.toFixed(2)}   distinct summaries/answer  ${report.meanDistinctSummaries.toFixed(2)}`,
    `answers with a knowledge tile  ${pct(report.knowledgeAnswerShare)}`,
    ...report.probes.map(p => `  probe ${p.passed ? 'PASS' : 'FAIL'}  ${p.name}  (${p.tiles} tiles)`),
    out ? `report written to ${out}` : '',
  ].filter(Boolean);
  process.stdout.write(lines.join('\n') + '\n');
}
