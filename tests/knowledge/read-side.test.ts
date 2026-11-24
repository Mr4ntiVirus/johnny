import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { embed, getEmbedModelName } from '../../src/utils/llm.js';
import * as factsDb from '../../src/store/db/facts.js';
import * as obsDb from '../../src/store/db/observations.js';
import * as modelsDb from '../../src/store/db/mental-models.js';
import * as jobs from '../../src/store/db/jobs.js';
import { upsertSession, clearKnowledgeSurfaced, getSurfacedMap } from '../../src/store/db/sessions.js';
import { selectRecall, handleRecall, handleSearch } from '../../src/mcp/index.js';
import { handleModels, handleReflect, invalidateKnowledgeRef, isKnowledgeRef } from '../../src/mcp/knowledge-tools.js';
import { computePrime } from '../../src/knowledge/prime.js';
import { embedSections } from '../../src/knowledge/refresh.js';
import { splitSections } from '../../src/knowledge/sections.js';
import { resetChunkIndexCache } from '../../src/engine/chunk-index.js';
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/knowledge/config.js';

const kcfg = { ...DEFAULT_KNOWLEDGE_CONFIG, prime: true };
const MODEL_Q = 'Relay overview. How is the Johnny database relay configured and where does it live?';
const OBS_TEXT = 'The Johnny database relay is a Pooler instance reachable at relay.example.com on port 8443 using mutual TLS.';
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

async function seedKnowledge(opts: { proofSessions?: number } = {}) {
  const sessions = opts.proofSessions ?? 3;
  const oid = await obsDb.createObservation({
    scope: 'global', text: OBS_TEXT, facet: 'relay', subject: 'relay',
    embedding: await embed(OBS_TEXT), embeddingModel: getEmbedModelName(),
  });
  const factIds: string[] = [];
  for (let i = 0; i < sessions; i++) {
    const fid = await factsDb.createFact({
      scope: 'global', text: `Relay fact ${i}: reachable at relay.example.com:8443`, kind: 'state',
      sessionId: `sess-${i}`, sourceQuote: 'relay on 8443 with mutual TLS', embedding: await embed(`Relay fact ${i}`), embeddingModel: getEmbedModelName(),
    });
    factIds.push(fid);
    await obsDb.addEvidence(oid, fid, 'relay on 8443 with mutual TLS');
  }
  await obsDb.recomputeProof(oid);
  await modelsDb.createModel({
    slug: 'relay-overview', name: 'Relay overview', sourceQuery: MODEL_Q, scope: 'global',
    queryEmbedding: await embed(MODEL_Q), embeddingModel: getEmbedModelName(),
  });
  const content = '## Network\nThe relay is a Pooler instance at relay.example.com port 8443, mutual TLS only.\n\n## Role\nIt fronts the hibernating database for Johnny.';
  await modelsDb.writeModelContent('relay-overview', content, [oid], new Date().toISOString(), 'test', await embedSections(content));
  return { oid, factIds };
}

describe('knowledge in recall / search', () => {
  useTestDb();
  beforeEach(() => resetChunkIndexCache());

  it('a compiled model outranks raw tiles and is labelled with provenance', async () => {
    await seedKnowledge();
    const sel = await selectRecall({ query: MODEL_Q, limit: 6 });
    if ('empty' in sel) throw new Error('empty');
    expect(sel.selected[0].chunkId).toBe('model:relay-overview');
    expect(sel.selected[0].text).toContain('compiled model "Relay overview"');
    const out = text(await handleRecall({ query: MODEL_Q, limit: 6 }));
    expect(out).toContain('compiled model: Relay overview');
    expect(out).toContain('Compiled:'); // knowledge header, not "Topics/Created"
  });

  it('does not touch memory retrieval counters for knowledge tiles (no bogus memory ids)', async () => {
    await seedKnowledge();
    await expect(handleRecall({ query: MODEL_Q, limit: 4 })).resolves.toBeTruthy();
  });

  it('paginates past knowledge tiles with excludeChunkIds', async () => {
    await seedKnowledge();
    const first = await selectRecall({ query: MODEL_Q, limit: 3 });
    if ('empty' in first) throw new Error('empty');
    const ids = first.selected.map(t => t.chunkId);
    expect(ids).toContain('model:relay-overview');
    const next = await selectRecall({ query: MODEL_Q, limit: 3, excludeChunkIds: ids });
    if (!('empty' in next)) for (const t of next.selected) expect(ids).not.toContain(t.chunkId);
  });

  it('search lists compiled knowledge first', async () => {
    await seedKnowledge();
    const out = text(await handleSearch({ query: MODEL_Q }));
    expect(out).toContain('Compiled knowledge');
    expect(out).toContain('model:relay-overview');
  });
});

describe('johnny_models', () => {
  useTestDb();

  it('lists, reads in full, and queues a refresh without calling a model', async () => {
    expect(text(await handleModels({}))).toContain('No compiled mental models yet');
    await seedKnowledge();
    const list = text(await handleModels({}));
    expect(list).toContain('relay-overview');
    expect(list).toContain('Answers:');
    const one = text(await handleModels({ name: 'relay-overview' }));
    expect(one).toContain('Pooler instance');
    expect(text(await handleModels({ name: 'nope' }))).toContain('No model named');

    const q = text(await handleModels({ name: 'relay-overview', refresh: true }));
    expect(q).toContain('Refresh requested');
    expect((await modelsDb.getModelBySlug('relay-overview'))!.force_stale).toBe(1);
    expect(await jobs.anyPending('models')).toBe(true);
  });
});

describe('johnny_reflect', () => {
  useTestDb();
  beforeEach(() => resetChunkIndexCache());

  it('returns layers in order with evidence quotes, and no LLM call', async () => {
    await seedKnowledge();
    const out = text(await handleReflect({ question: MODEL_Q }, { rawTiles: async () => [{ memoryName: 'old-session', chunkId: 'old#1', text: 'raw excerpt about the relay', score: 0.6 }] }));
    const iModels = out.indexOf('COMPILED MODELS');
    const iObs = out.indexOf('OBSERVATIONS');
    const iRaw = out.indexOf('RAW MEMORY');
    expect(iModels).toBeGreaterThan(-1);
    expect(iObs).toBeGreaterThan(iModels);
    expect(iRaw).toBeGreaterThan(iObs);
    expect(out).toContain('[model:relay-overview]');
    expect(out).toContain('backed by 3 sessions');
    expect(out).toContain('relay on 8443 with mutual TLS'); // evidence quote
    expect(out).toContain('johnny_invalidate');
  });

  it('handles empty input and no matches', async () => {
    expect(text(await handleReflect({ question: '  ' }, { rawTiles: async () => [] }))).toContain('requires a question');
    expect(text(await handleReflect({ question: 'zzz qqq' }, { rawTiles: async () => [] }))).toContain('Nothing in memory matched');
  });
});

describe('invalidating knowledge refs', () => {
  useTestDb();

  it('recognises refs', () => {
    expect(isKnowledgeRef('fact:1')).toBe(true);
    expect(isKnowledgeRef('obs:1')).toBe(true);
    expect(isKnowledgeRef('model:x')).toBe(true);
    expect(isKnowledgeRef('some-memory-slug')).toBe(false);
  });

  it('flagging a fact marks contradicting evidence, drops proof, and stales dependent models', async () => {
    const { oid, factIds } = await seedKnowledge({ proofSessions: 3 });
    const r = text(await invalidateKnowledgeRef(`fact:${factIds[0]}`, 'port changed'));
    expect(r).toContain('Fact flagged');
    expect((await obsDb.getObservation(oid))!.proof_count).toBe(2); // that session no longer supports it
    expect((await modelsDb.getModelBySlug('relay-overview'))!.force_stale).toBe(1);
    expect(await jobs.anyPending('consolidate')).toBe(true);
  });

  it('two flags on an observation stop it from being auto-primed; flagging a model requeues it', async () => {
    const { oid } = await seedKnowledge();
    await invalidateKnowledgeRef(`obs:${oid}`);
    await invalidateKnowledgeRef(`obs:${oid}`);
    expect((await obsDb.getObservation(oid))!.invalidation_count).toBe(2);
    expect(text(await invalidateKnowledgeRef('model:relay-overview'))).toContain('marked stale');
    expect(text(await invalidateKnowledgeRef('model:missing'))).toContain('No model');
    expect(text(await invalidateKnowledgeRef('weird:thing'))).toContain('Unrecognised');
  });
});

describe('computePrime (automatic priming decision)', () => {
  useTestDb();
  let cwd: string;
  const base = () => ({
    promptText: 'how is the relay configured and where does it live', cwd, sessionId: 'prime-s1', turn: 1,
    trigger: 'first-prompt' as const, config: kcfg,
  });

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-prime-'));
    await upsertSession({ sessionId: 'prime-s1' });
  });

  it('primes a verified model with a prose digest, then respects the cooldown', async () => {
    await seedKnowledge();
    const emb = await embed(MODEL_Q);
    const p1 = await computePrime({ ...base(), promptEmbedding: emb });
    expect(p1).not.toBeNull();
    expect(p1!.additionalContext).toContain('Johnny recalled this from your long-term memory');
    expect(p1!.additionalContext).toContain('Pooler');
    expect(p1!.refs).toContain('model:relay-overview');
    expect(Object.keys(await getSurfacedMap('prime-s1'))).toContain('model:relay-overview');

    // same session: never re-injected, however many turns pass or how exact the match is,
    // until a compaction clears it from context.
    // (a different item — e.g. the observation behind the model — may still prime later; the same one never does.)
    const again = (r: Awaited<ReturnType<typeof computePrime>>) => r?.refs.includes('model:relay-overview') ?? false;
    expect(again(await computePrime({ ...base(), promptEmbedding: emb, turn: 2, trigger: 'continuation' }))).toBe(false);
    expect(again(await computePrime({ ...base(), promptEmbedding: emb, turn: 40, trigger: 'topic-switch' }))).toBe(false);
  });

  it('post-compaction reset makes primed items eligible again', async () => {
    await seedKnowledge();
    const emb = await embed(MODEL_Q);
    await computePrime({ ...base(), promptEmbedding: emb });
    const hasModel = (r: Awaited<ReturnType<typeof computePrime>>) => r?.refs.includes('model:relay-overview') ?? false;
    expect(hasModel(await computePrime({ ...base(), promptEmbedding: emb, turn: 2, trigger: 'continuation' }))).toBe(false);
    expect(await clearKnowledgeSurfaced('prime-s1')).toBeGreaterThan(0);
    expect(hasModel(await computePrime({ ...base(), promptEmbedding: emb, turn: 3, trigger: 'topic-switch' }))).toBe(true);
  });

  it('matches the SECTION that answers the prompt, and primes only that section', async () => {
    await seedKnowledge();
    const m = (await modelsDb.getModelBySlug('relay-overview'))!;
    expect(modelsDb.modelSectionEmbeddings(m)).toHaveLength(splitSections(m.content!).length);
    // The prompt is exactly the "Role" section: far from the generic title+question, identical to that section.
    const roleSection = splitSections(m.content!)[1];
    const p = await computePrime({ ...base(), promptText: roleSection, promptEmbedding: await embed(roleSection) });
    expect(p).not.toBeNull();
    expect(p!.additionalContext).toContain('fronts the hibernating database');
    expect(p!.additionalContext).not.toContain('Pooler instance at relay.example.com'); // the other section is not injected
  });

  it('dry-run mode neither reads nor writes the surfaced map, and explains each candidate', async () => {
    await seedKnowledge();
    const emb = await embed(MODEL_Q);
    const trace: import('../../src/knowledge/prime.js').PrimeTrace[] = [];
    const p1 = await computePrime({ ...base(), promptEmbedding: emb, dryRun: true, trace });
    expect(p1).not.toBeNull();
    expect(Object.keys(await getSurfacedMap('prime-s1'))).toEqual([]);          // nothing written
    expect(trace.some(t => t.verdict.startsWith('PRIMED'))).toBe(true);
    // identical second dry run still primes (it does not see its own first run)
    expect(await computePrime({ ...base(), promptEmbedding: emb, dryRun: true })).not.toBeNull();
  });

  it('dry-run accepts a caller-supplied surfaced map, so a replay can model once-per-epoch without touching the store', async () => {
    await seedKnowledge();
    const emb = await embed(MODEL_Q);
    const hasModel = (r: Awaited<ReturnType<typeof computePrime>>) => r?.refs.includes('model:relay-overview') ?? false;
    expect(hasModel(await computePrime({ ...base(), promptEmbedding: emb, dryRun: true, surfaced: {} }))).toBe(true);
    expect(hasModel(await computePrime({ ...base(), promptEmbedding: emb, dryRun: true, surfaced: { 'model:relay-overview': 1 } }))).toBe(false);
    expect(Object.keys(await getSurfacedMap('prime-s1'))).toEqual([]);          // still nothing written
  });

  it('is off by default / when the flag is false', async () => {
    await seedKnowledge();
    const emb = await embed(MODEL_Q);
    expect(await computePrime({ ...base(), promptEmbedding: emb, config: { ...kcfg, prime: false } })).toBeNull();
  });

  it('trust gates: an observation backed by a single session is never primed', async () => {
    await obsDb.createObservation({ scope: 'global', text: OBS_TEXT, embedding: await embed(OBS_TEXT), embeddingModel: getEmbedModelName() });
    const r = await computePrime({ ...base(), promptEmbedding: await embed(OBS_TEXT) });
    expect(r).toBeNull(); // proof_count 0/1 < primeMinProof
  });

  it('does not prime knowledge already present in the always-loaded CLAUDE.md', async () => {
    await seedKnowledge();
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'),
      'Relay notes: The relay is a Pooler instance at relay.example.com port 8443, mutual TLS only. It fronts the hibernating database for Johnny.');
    const r = await computePrime({ ...base(), promptEmbedding: await embed(MODEL_Q) });
    expect(r).toBeNull();
  });

  it('a disputed observation is not primed even with plenty of proof', async () => {
    const { oid } = await seedKnowledge();
    await modelsDb.setModelStatus('relay-overview', 'archived'); // isolate the observation path
    await obsDb.invalidateObservation(oid);
    await obsDb.invalidateObservation(oid);
    const r = await computePrime({ ...base(), promptEmbedding: await embed(OBS_TEXT) });
    expect(r).toBeNull();
  });
});
