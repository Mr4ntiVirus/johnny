// End-to-end synthesis pipeline with a scripted MockSynthesizer (no live model):
// extract -> verify -> consolidate -> auto-create model -> refresh (verified).
// Runs on in-memory SQLite — the store the scheduled synthesis job actually uses.
import { describe, it, expect } from 'vitest';
import { beforeEach, afterAll } from 'vitest';
import { setDatabasePath, closeDatabase } from '../../src/store/database.js';
import { cfg, seed, scripted } from '../helpers/pipeline-fixtures.js';
import * as factsDb from '../../src/store/db/facts.js';
import * as obsDb from '../../src/store/db/observations.js';
import * as modelsDb from '../../src/store/db/mental-models.js';
import * as jobs from '../../src/store/db/jobs.js';
import * as hist from '../../src/store/db/knowledge-history.js';
import { runSynthesis, synthStatus, formatReport } from '../../src/knowledge/run.js';
import { MockSynthesizer, SynthAuthError, SynthError } from '../../src/knowledge/synth.js';

describe('synthesis pipeline on local SQLite (mock model)', () => {
  beforeEach(() => {
    closeDatabase();
    setDatabasePath(':memory:');
    process.env.JOHNNY_LOCAL_STORE = '1';
  });
  afterAll(() => { closeDatabase(); });

  it('turns memories into facts -> observations -> an auto-created, verified model', async () => {
    await seed('m-aws', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    await seed('m-ssh', 'The SSH user is ubuntu on stream and fetch and ec2-user on the audio box');
    await seed('m-key', 'The SSH key for all servers lives at the path ~/key.pem on this laptop');

    const { synth, calls } = scripted();
    const st0 = await synthStatus();
    expect(st0.pendingMemories).toBe(3);
    expect(st0.needsWork).toBe(true);

    const report = await runSynthesis({ synth, config: cfg(), rng: () => 0 });
    expect(report.stopped).toBe('done');
    expect(report.extraction).toMatchObject({ memories: 3, factsAccepted: 3, factsRejected: 0 });
    expect(report.extraction.verifierChecked).toBe(3);
    expect(report.extraction.verifierUnsupported).toBe(0);
    expect(report.consolidation.created).toBe(3);

    // facts are quote-grounded, global-scoped and carry their session
    const facts = await factsDb.listActiveFacts('global');
    expect(facts).toHaveLength(3);
    for (const f of facts) {
      expect(f.source_quote!.length).toBeGreaterThan(10);
      expect(f.session_id).toMatch(/^sess-/);
    }
    // observations: one per fact, evidence linked, proof = distinct sessions (1 each)
    const obs = await obsDb.listActiveObservations('global');
    expect(obs).toHaveLength(3);
    for (const o of obs) {
      expect(o.proof_count).toBe(1);
      expect((await obsDb.getEvidence(o.id))).toHaveLength(1);
    }

    // a core model created itself (>=3 global observations) and was refreshed + verified
    const models = await modelsDb.listModels({ status: 'active' });
    expect(models.map(m => m.slug)).toEqual(['conventions-and-environment']);
    const m = models[0];
    expect(m.origin).toBe('seed');
    expect(m.content).toContain('## Conventions');
    expect(m.content).not.toMatch(/\[[OF]\d+\]/); // citations stripped from stored text
    expect(modelsDb.modelBasedOn(m).length).toBeGreaterThan(0);
    expect(report.models.refreshed).toContain('conventions-and-environment');
    expect(calls.some(c => c.role === 'verify' && c.prompt.includes('DOCUMENT TO CHECK'))).toBe(true); // 100% verified

    // nothing pending now -> precheck says skip, and a second run makes ZERO model calls
    const st1 = await synthStatus();
    expect(st1).toMatchObject({ pendingMemories: 0, pendingConsolidateScopes: 0, staleModels: 0 });
    expect(st1.needsWork).toBe(false);
    const before = calls.length;
    const again = await runSynthesis({ synth, config: cfg() });
    expect(again.extraction.memories).toBe(0);
    expect(calls.length).toBe(before);

    expect(formatReport(report)).toContain('3 facts accepted');
  });

  it('stops gracefully at the per-run call budget and resumes next run', async () => {
    for (let i = 0; i < 3; i++) await seed(`b-${i}`, `Always do thing number ${i} exactly this way for the whole workspace`);
    const { synth } = scripted();
    const r1 = await runSynthesis({ synth, config: cfg({ maxCallsPerRun: 1 }), phases: ['extract'] });
    expect(r1.stopped).toBe('budget-run');
    expect(r1.usage.runCalls).toBe(1);
    const r2 = await runSynthesis({ synth, config: cfg({ maxCallsPerRun: 50 }), phases: ['extract'] });
    expect(['done']).toContain(r2.stopped);
    expect((await synthStatus()).pendingMemories).toBe(0);
  });

  it('auto-pauses extraction when most output fails validation, and reports why', async () => {
    await seed('bad-1', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    const { synth } = scripted({ badQuotes: true });
    const r = await runSynthesis({ synth, config: cfg(), phases: ['extract'] });
    expect(r.extraction.factsAccepted).toBe(0);
    expect(r.extraction.factsRejected).toBeGreaterThanOrEqual(40);
    expect(r.notes.join(' ')).toMatch(/auto-paused/);
    expect((await jobs.getJob('extract', ''))!.paused).toBe(1);
    // paused => a later run does not call the model for extraction
    const st = await synthStatus();
    expect(st.paused).toContain('extract');
  });

  it('a model whose output the verifier keeps rejecting is never written; old content is preserved', async () => {
    await seed('v-1', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    await seed('v-2', 'The SSH user is ubuntu on stream and fetch and ec2-user on the audio box');
    await seed('v-3', 'The SSH key for all servers lives at the path ~/key.pem on this laptop');
    // first: a good run so a model exists with content
    await runSynthesis({ synth: scripted().synth, config: cfg(), rng: () => 0 });
    const good = (await modelsDb.getModelBySlug('conventions-and-environment'))!;
    expect(good.content).toBeTruthy();

    // new knowledge arrives, but the verifier rejects the refreshed document
    await seed('v-4', 'The deploy script is always staged to the shared bucket before pulling on the box');
    const r = await runSynthesis({ synth: scripted({ unsupportedModel: true }).synth, config: cfg(), rng: () => 0 });
    expect(r.models.failed.length).toBe(1);
    const after = (await modelsDb.getModelBySlug('conventions-and-environment'))!;
    expect(after.content).toBe(good.content);       // never replaced with unverified text
    expect(after.fail_count).toBeGreaterThan(0);
    expect(await hist.getHistory('model', after.id)).toEqual([]); // no new version was written
  });

  it('does not run concurrently: a held synth claim makes the run a no-op', async () => {
    await seed('c-1', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    expect(await jobs.claimJob('synth', '', 'someone-else')).toBe(true);
    const { synth, calls } = scripted();
    const r = await runSynthesis({ synth, config: cfg() });
    expect(r.skipped).toMatch(/another synthesis run/);
    expect(calls).toHaveLength(0);
  });

  it('a login outage (auth error) stops the run with a backoff and pauses NOTHING', async () => {
    await seed('a-1', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    const down = new MockSynthesizer(() => { throw new SynthAuthError('claude login unavailable: Not logged in'); });
    const r = await runSynthesis({ synth: down, config: cfg() });
    expect(r.stopped).toBe('rate-limit');
    expect(r.notes.join(' ')).toMatch(/backing off/);
    const st = await synthStatus();
    expect(st.paused).toEqual([]);                  // nothing auto-paused
    expect(st.backoffUntil).toBeTruthy();           // retry later automatically
    expect(st.needsWork).toBe(false);               // during the backoff the heartbeat skips quietly
  });

  it('infrastructure errors (CLI crash/timeout) are transient: run stops, extraction is NOT paused', async () => {
    await seed('i-1', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    for (let i = 0; i < 4; i++) {
      const crashing = new MockSynthesizer(() => { throw new SynthError('claude timed out after 240000ms'); });
      const r = await runSynthesis({ synth: crashing, config: cfg(), phases: ['extract'] });
      expect(r.notes.join(' ')).toMatch(/infrastructure/);
    }
    expect((await synthStatus()).paused).toEqual([]); // four crashes in a row still never pause the step
    // and the very next healthy run extracts normally
    const ok = await runSynthesis({ synth: scripted().synth, config: cfg(), phases: ['extract'], rng: () => 0 });
    expect(ok.extraction.factsAccepted).toBe(1);
  });

  it('runs extraction calls concurrently but never above the configured width', async () => {
    for (let i = 0; i < 6; i++) await seed(`p-${i}`, `Always do thing number ${i} exactly this way for the whole workspace here`);
    const base = scripted().synth;
    let inFlight = 0, maxInFlight = 0;
    const slow = new MockSynthesizer(async (req) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 15));
      inFlight--;
      return (await base.complete(req)).text;
    });
    const c = cfg({ windowsPerCall: 1, memoriesPerBatch: 6, concurrency: 3, verifySampleRate: 0 });
    const r = await runSynthesis({ synth: slow, config: c, phases: ['extract'] });
    expect(r.extraction.factsAccepted).toBe(6);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('the per-run call cap stays exact under concurrency (calls are reserved, not counted after the fact)', async () => {
    for (let i = 0; i < 6; i++) await seed(`q-${i}`, `Always do thing number ${i} exactly this way for the whole workspace here`);
    const c = cfg({ windowsPerCall: 1, memoriesPerBatch: 6, concurrency: 3, maxCallsPerRun: 2, verifySampleRate: 0 });
    const r = await runSynthesis({ synth: scripted().synth, config: c, phases: ['extract'] });
    expect(r.stopped).toBe('budget-run');
    expect(r.usage.runCalls).toBe(2);
  });

  it('extraction is sliced per run so consolidation and models still get their turn on a big backlog', async () => {
    for (let i = 0; i < 5; i++) await seed(`s-${i}`, `The rule number ${i} for this workspace is to always do it exactly this particular way`);
    const { synth } = scripted();
    const r = await runSynthesis({ synth, config: cfg({ maxMemoriesPerRun: 2, memoriesPerBatch: 2, verifySampleRate: 0 }) });
    expect(r.extraction.memories).toBe(2);               // only a slice of the backlog extracted...
    expect(r.consolidation.created).toBeGreaterThan(0);  // ...but consolidation ran in the same pass
    expect((await synthStatus()).pendingMemories).toBe(3);
    expect(r.stopped).toBe('done');
  });

  it('consolidates several scopes concurrently without cross-talk', async () => {
    const names = ['alpha-service', 'bravo-gateway', 'charlie-worker'];
    for (const [pi, proj] of ['/tmp/proj-a', '/tmp/proj-b', '/tmp/proj-c'].entries()) {
      for (let i = 0; i < 2; i++) await seed(`${proj.slice(-1)}-${i}`, `The ${names[pi]} listens on port ${9000 + pi * 10 + i} and must always be started with the flag number ${pi * 10 + i} first`, proj);
    }
    const r = await runSynthesis({ synth: scripted().synth, config: cfg({ concurrency: 3, verifySampleRate: 0 }), phases: ['extract', 'consolidate'] });
    expect(r.stopped).toBe('done');
    expect(r.consolidation.scopes).toBeGreaterThanOrEqual(1);
    const scopes = new Set((await obsDb.listActiveObservations(null, 100)).map(o => o.scope));
    // scripted facts are `applies: global`, so everything lands in the one global scope — and nothing is lost or duplicated
    expect(scopes.has('global')).toBe(true);
    expect((await obsDb.listActiveObservations('global')).length).toBe(6);
  });

  it('an all-failed run reports an error but never pauses the heartbeat (stays retryable)', async () => {
    await seed('m-aws', 'Always use AWS_PROFILE=default for every aws command in this workspace');
    const broken = new MockSynthesizer(() => { throw new SynthError('claude exited 1: something unexpected'); });
    for (let i = 0; i < 3; i++) {
      const r = await runSynthesis({ synth: broken, config: cfg(), rng: () => 0 });
      expect(r.stopped).toBe('error');
      expect(r.errors.join(' ')).toMatch(/no model call succeeded/);
    }
    const st = await synthStatus();
    expect(st.paused).not.toContain('synth');
    expect(st.needsWork).toBe(true);
  });
});
