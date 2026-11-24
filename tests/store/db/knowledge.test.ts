import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as ledger from '../../../src/store/db/snapshot-ledger.js';
import * as jobs from '../../../src/store/db/jobs.js';
import * as factsDb from '../../../src/store/db/facts.js';
import * as obsDb from '../../../src/store/db/observations.js';
import * as modelsDb from '../../../src/store/db/mental-models.js';
import * as hist from '../../../src/store/db/knowledge-history.js';

describe('snapshot_ledger', () => {
  useTestDb();

  it('records and looks up uuids, ignoring duplicates', async () => {
    await ledger.recordLedger(['u1', 'u2', 'u2'], 's1', 'm1');
    await ledger.recordLedger(['u2', 'u3'], 's2', 'm2'); // u2 already present: no error
    const seen = await ledger.getLedgeredUuids(['u1', 'u2', 'u3', 'nope']);
    expect([...seen].sort()).toEqual(['u1', 'u2', 'u3']);
    expect(await ledger.getLedgerCount()).toBe(3);
  });

  it('handles large batches across the variable limit', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `bulk-${i}`);
    await ledger.recordLedger(many, 's', null);
    const seen = await ledger.getLedgeredUuids([...many, 'missing']);
    expect(seen.size).toBe(1000);
  });
});

describe('job_state', () => {
  useTestDb();

  it('claim is exclusive until released or stale', async () => {
    expect(await jobs.claimJob('extract', '', 'worker-a')).toBe(true);
    expect(await jobs.claimJob('extract', '', 'worker-b')).toBe(false);
    await jobs.releaseJob('extract', '', 'worker-b'); // wrong owner: no effect
    expect(await jobs.claimJob('extract', '', 'worker-b')).toBe(false);
    await jobs.releaseJob('extract', '', 'worker-a');
    expect(await jobs.claimJob('extract', '', 'worker-b')).toBe(true);
  });

  it('a stale claim (crashed worker) can be re-claimed', async () => {
    expect(await jobs.claimJob('consolidate', 'p', 'a', 60_000)).toBe(true);
    // ttl 0 => anything claimed before "now" is stale
    await new Promise(r => setTimeout(r, 5));
    expect(await jobs.claimJob('consolidate', 'p', 'b', 0)).toBe(true);
  });

  it('auto-pauses after the failure threshold and blocks claims until resumed', async () => {
    expect(await jobs.recordFailure('models', '', 'boom1')).toBe(false);
    expect(await jobs.recordFailure('models', '', 'boom2')).toBe(false);
    expect(await jobs.recordFailure('models', '', 'boom3')).toBe(true);
    expect((await jobs.getJob('models', ''))!.paused).toBe(1);
    expect(await jobs.claimJob('models', '', 'w')).toBe(false);
    await jobs.resume('models', '');
    expect(await jobs.claimJob('models', '', 'w')).toBe(true);
  });

  it('success clears failures; pending flag drives anyPending', async () => {
    await jobs.recordFailure('x', '', 'e');
    await jobs.recordSuccess('x', '');
    const j = await jobs.getJob('x', '');
    expect(j!.fail_count).toBe(0);
    expect(await jobs.anyPending()).toBe(false);
    await jobs.setPending('x', '', true);
    expect(await jobs.anyPending()).toBe(true);
    expect(await jobs.anyPending('other')).toBe(false);
    await jobs.setPending('x', '', false);
    expect(await jobs.anyPending()).toBe(false);
  });

  it('stores watermark and stats', async () => {
    await jobs.setWatermark('extract', '', '2026-10-12T00:00:00.000Z');
    await jobs.recordStats('extract', '', { windows: 3 });
    const j = await jobs.getJob('extract', '');
    expect(j!.watermark).toBe('2026-10-12T00:00:00.000Z');
    expect(JSON.parse(j!.stats!)).toEqual({ windows: 3 });
  });
});

describe('facts', () => {
  useTestDb();

  const base = { scope: 'global', text: 'AWS CLI calls use profile default.', kind: 'convention' as const };

  it('creates a fact with normalised entities and reads it back', async () => {
    const id = await factsDb.createFact({ ...base, entities: ['AWS CLI', 'aws cli', ' Profile  Default '], sourceQuote: 'use --profile default', sessionId: 's1' });
    const f = await factsDb.getFact(id);
    expect(f).toMatchObject({ scope: 'global', kind: 'convention', status: 'active', origin: 'extracted' });
    expect((await factsDb.getFactEntities(id)).sort()).toEqual(['aws cli', 'profile default']);
    expect((await factsDb.findFactsByEntity('aws cli')).map(x => x.id)).toEqual([id]);
  });

  it('supersede keeps the row and links the successor (never deletes)', async () => {
    const old = await factsDb.createFact(base);
    const next = await factsDb.createFact({ ...base, text: 'AWS CLI calls use profile work.' });
    await factsDb.supersedeFact(old, next);
    const f = await factsDb.getFact(old);
    expect(f).toMatchObject({ status: 'superseded', superseded_by: next });
    expect(f!.valid_to).toBeTruthy();
    const active = await factsDb.listActiveFacts('global');
    expect(active.map(x => x.id)).toEqual([next]);
  });

  it('two invalidations mark a fact disputed; a replacement supersedes at once', async () => {
    const id = await factsDb.createFact(base);
    expect(await factsDb.invalidateFact(id)).toBe('active');
    expect(await factsDb.invalidateFact(id)).toBe('disputed');
    const id2 = await factsDb.createFact({ ...base, text: 'other' });
    const repl = await factsDb.createFact({ ...base, text: 'replacement' });
    expect(await factsDb.invalidateFact(id2, repl)).toBe('superseded');
    expect(await factsDb.invalidateFact('missing')).toBeNull();
  });

  it('extraction_log is idempotent and counts attempts', async () => {
    expect(await factsDb.getExtractionLog('h1', 'x1')).toBeNull();
    await factsDb.recordExtraction('h1', 'x1', 'failed', 0, 'boom');
    await factsDb.recordExtraction('h1', 'x1', 'done', 2);
    const l = await factsDb.getExtractionLog('h1', 'x1');
    expect(l).toMatchObject({ status: 'done', fact_count: 2, attempts: 2, last_error: null });
    expect(await factsDb.countExtracted('x1')).toBe(1);
    expect(await factsDb.countExtracted('x2')).toBe(0);
  });
});

describe('observations', () => {
  useTestDb();

  async function factIn(session: string | null, text = 'f'): Promise<string> {
    return factsDb.createFact({ scope: 'proj', text, kind: 'state', sessionId: session, sourceMemoryId: session ? null : 'mem-x' });
  }

  it('create/update write history; supersede links successor and keeps the row', async () => {
    const o1 = await obsDb.createObservation({ scope: 'proj', text: 'The relay lives at music host port 8443.' });
    await obsDb.updateObservationText(o1, 'The relay lives at the music host on port 8443 (mTLS).', 'added mTLS');
    const h = await hist.getHistory('observation', o1);
    expect(h.map(x => x.reason)).toEqual(['added mTLS', 'created']);
    expect(h[0].content).toBe('The relay lives at music host port 8443.');

    const o2 = await obsDb.createObservation({ scope: 'proj', text: 'The relay moved to a container.' });
    await obsDb.supersedeObservation(o1, o2, 'relay moved');
    expect(await obsDb.getObservation(o1)).toMatchObject({ status: 'superseded', superseded_by: o2 });
    const active = await obsDb.listActiveObservations('proj');
    expect(active.map(o => o.id)).toEqual([o2]);
    // retire (no successor)
    await obsDb.supersedeObservation(o2, null, 'obsolete');
    expect((await obsDb.getObservation(o2))!.status).toBe('retired');
  });

  it('proof_count counts DISTINCT SESSIONS of supporting facts only', async () => {
    const o = await obsDb.createObservation({ scope: 'proj', text: 'obs' });
    const f1 = await factIn('sess-1', 'a');
    const f2 = await factIn('sess-1', 'b'); // same session: must not add proof
    const f3 = await factIn('sess-2', 'c');
    const f4 = await factIn('sess-3', 'd');
    await obsDb.addEvidence(o, f1, 'q1');
    await obsDb.addEvidence(o, f2, 'q2');
    await obsDb.addEvidence(o, f3, 'q3');
    await obsDb.addEvidence(o, f4, 'q4', 'contradicts'); // contradicting evidence is not proof
    expect(await obsDb.recomputeProof(o)).toBe(2);
    expect((await obsDb.getObservation(o))!.proof_count).toBe(2);
    expect((await obsDb.getEvidence(o)).map(e => e.role).sort()).toEqual(['contradicts', 'supports', 'supports', 'supports']);
    expect(await obsDb.observationsForFact(f1)).toEqual([o]);
  });

  it('rejected observations never surface; scope includes global', async () => {
    const g = await obsDb.createObservation({ scope: 'global', text: 'global one' });
    const p = await obsDb.createObservation({ scope: 'proj', text: 'proj one' });
    const other = await obsDb.createObservation({ scope: 'other', text: 'other one' });
    await obsDb.setReviewState(p, 'rejected');
    const ids = (await obsDb.listActiveObservations('proj')).map(o => o.id);
    expect(ids).toContain(g);
    expect(ids).not.toContain(p);
    expect(ids).not.toContain(other);
  });
});

describe('knowledge_history cap', () => {
  useTestDb();

  it('keeps at most HISTORY_CAP versions per ref', async () => {
    for (let i = 0; i < hist.HISTORY_CAP + 7; i++) await hist.addHistory('model', 'ref-1', `v${i}`, `r${i}`);
    const all = await hist.getHistory('model', 'ref-1', 500);
    expect(all.length).toBe(hist.HISTORY_CAP);
    expect(all[0].content).toBe(`v${hist.HISTORY_CAP + 6}`);
  });
});

describe('mental_models', () => {
  useTestDb();

  it('create is born stale; write stores prior content in history and clears staleness', async () => {
    await modelsDb.createModel({ slug: 'conventions', name: 'Conventions', sourceQuery: 'What conventions apply?', scope: 'global' });
    let m = (await modelsDb.getModelBySlug('conventions'))!;
    expect(m).toMatchObject({ force_stale: 1, status: 'active', origin: 'auto' });
    expect(m.content).toBeNull();

    await modelsDb.writeModelContent('conventions', 'v1 text', ['O1'], '2026-10-01T00:00:00.000Z', 'initial');
    await modelsDb.writeModelContent('conventions', 'v2 text', ['O1', 'O2'], '2026-10-02T00:00:00.000Z', 'refresh');
    m = (await modelsDb.getModelBySlug('conventions'))!;
    expect(m.content).toBe('v2 text');
    expect(m.force_stale).toBe(0);
    expect(m.last_seen_at).toBe('2026-10-02T00:00:00.000Z');
    expect(modelsDb.modelBasedOn(m)).toEqual(['O1', 'O2']);
    const h = await hist.getHistory('model', m.id);
    expect(h.map(x => x.content)).toEqual(['v1 text']); // first write had no prior content
  });

  it('failures pause the model after the threshold; force_stale can be re-set', async () => {
    await modelsDb.createModel({ slug: 'm', name: 'M', sourceQuery: 'q', scope: 'global' });
    await modelsDb.markModelFailure('m', 'e1');
    await modelsDb.markModelFailure('m', 'e2');
    expect((await modelsDb.getModelBySlug('m'))!.paused).toBe(0);
    await modelsDb.markModelFailure('m', 'e3');
    expect((await modelsDb.getModelBySlug('m'))!.paused).toBe(1);
    await modelsDb.writeModelContent('m', 'ok', [], null, 'manual');
    expect((await modelsDb.getModelBySlug('m'))!.paused).toBe(0);
    await modelsDb.forceStale(['m']);
    expect((await modelsDb.getModelBySlug('m'))!.force_stale).toBe(1);
  });

  it('list filters by status and scope (scope includes global)', async () => {
    await modelsDb.createModel({ slug: 'a', name: 'A', sourceQuery: 'q', scope: 'global' });
    await modelsDb.createModel({ slug: 'b', name: 'B', sourceQuery: 'q', scope: '/p' });
    await modelsDb.createModel({ slug: 'c', name: 'C', sourceQuery: 'q', scope: '/other' });
    await modelsDb.setModelStatus('a', 'archived');
    expect((await modelsDb.listModels({ status: 'active', scope: '/p' })).map(m => m.slug)).toEqual(['b']);
    expect((await modelsDb.listModels({ scope: '/p' })).map(m => m.slug).sort()).toEqual(['a', 'b']);
  });
});
