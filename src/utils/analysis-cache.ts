// Thin memoizing wrapper around the vendored CMV analyzer's analyzeSession().
// src/vendor/cmv/ is do-not-edit (see CLAUDE.md), so caching lives here instead.
//
// analyzeSession() streams and JSON.parses the entire transcript JSONL on
// every call — within a single evaluate.ts hook process it can run twice
// (once directly, once again inside snapshot()) against the same file with
// nothing appended in between. Caching by path+mtime+size avoids paying that
// full-file cost twice per hook fire. This does NOT address large-session
// wall-clock stalls on its own — those are dominated by chunk-embedding
// (see chunker.ts's `deadline` option) and the daemon watcher's background
// maintenance (see daemon/watcher.ts) — it only trims a smaller, constant
// redundant cost paid on every fire regardless of backlog size.
import * as fsp from 'node:fs/promises';
import { analyzeSession as analyzeSessionRaw } from '../vendor/cmv/core/analyzer.js';
import type { SessionAnalysis } from '../vendor/cmv/types/index.js';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  analysis: SessionAnalysis;
}

const cache = new Map<string, CacheEntry>();

export async function analyzeSession(jsonlPath: string): Promise<SessionAnalysis> {
  const stat = await fsp.stat(jsonlPath);
  const hit = cache.get(jsonlPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.analysis;
  }
  const analysis = await analyzeSessionRaw(jsonlPath);
  cache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, analysis });
  return analysis;
}
