import { describe, it, expect } from 'vitest';
import { totalFailureNoSuccess, type RunReport } from '../../src/knowledge/run.js';

const base = (): RunReport => ({
  startedAt: '', durationMs: 0, stopped: 'done',
  extraction: { memories: 0, windows: 0, windowsFailed: 0, factsAccepted: 0, factsRejected: 0, rejectReasons: {}, verifierChecked: 0, verifierUnsupported: 0 },
  consolidation: { scopes: 0, created: 0, updated: 0, superseded: 0, retired: 0, merged: 0, rejected: 0 },
  models: { created: [], coreCreated: [], archived: [], merged: [], refreshed: [], unchanged: 0, failed: [] },
  embedded: 0, swept: 0, pagesExported: 0, usage: { runCalls: 0, runTokens: 0, callsToday: 0, tokensToday: 0 },
  backlog: { memories: 0, staleModels: 0 }, errors: [], notes: [],
});

describe('totalFailureNoSuccess', () => {
  it('is false for an idle run (nothing attempted)', () => {
    expect(totalFailureNoSuccess(base())).toBe(false);
  });
  it('is true when windows/models failed and nothing was produced', () => {
    const r = base(); r.extraction.windowsFailed = 4; r.models.failed.push({ slug: 'x', reason: 'Not logged in' });
    expect(totalFailureNoSuccess(r)).toBe(true);
  });
  it('counts recorded errors, but only when the model was actually called', () => {
    const r = base(); r.errors.push('extract: SynthError: claude exited 1');
    expect(totalFailureNoSuccess(r, 1)).toBe(true);
    expect(totalFailureNoSuccess(r, 0)).toBe(false);
  });
  it('is false when some work succeeded despite failures', () => {
    const r = base(); r.extraction.windowsFailed = 4; r.extraction.factsAccepted = 1;
    expect(totalFailureNoSuccess(r)).toBe(false);
  });
});
