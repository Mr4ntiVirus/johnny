// Shared fixtures for the synthesis pipeline tests (run on in-memory SQLite).
// End-to-end synthesis pipeline with a scripted MockSynthesizer (no live model):
// extract -> verify -> consolidate -> auto-create model -> refresh (verified).
import * as memoriesDb from '../../src/store/db/memories.js';
import * as factsDb from '../../src/store/db/facts.js';
import * as obsDb from '../../src/store/db/observations.js';
import * as modelsDb from '../../src/store/db/mental-models.js';
import * as jobs from '../../src/store/db/jobs.js';
import * as hist from '../../src/store/db/knowledge-history.js';
import { chunkAndPersistMemory } from '../../src/engine/chunker.js';
import { runSynthesis, synthStatus, formatReport } from '../../src/knowledge/run.js';
import { MockSynthesizer, type SynthRequest } from '../../src/knowledge/synth.js';
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/knowledge/config.js';
import type { KnowledgeConfig } from '../../src/types.js';

export const cfg = (over: Partial<KnowledgeConfig['synth']> = {}): KnowledgeConfig => ({
  ...DEFAULT_KNOWLEDGE_CONFIG,
  synth: { ...DEFAULT_KNOWLEDGE_CONFIG.synth, verifySampleRate: 1, windowsPerCall: 6, memoriesPerBatch: 6, ...over },
});

const PROSE = (marker: string, quote: string) =>
  `Alice: let us settle the setup for the project and write it down for later sessions.\n\n` +
  `Claude: Agreed. ${marker}: ${quote}\n\n` +
  `Alice: great, that matches how I run things on this machine every single day, so keep it in mind.\n\n` +
  `Claude: Noted. I will follow that convention in every future session without being reminded again.`;

export async function seed(slug: string, quote: string, project = '/tmp/proj-a'): Promise<string> {
  const id = await memoriesDb.createMemory({
    snapshotName: slug, title: slug, contentType: 'text', projectPath: project,
    sourceUri: `s3://example-bucket/snapshots/${slug}/session/sess-${slug}.jsonl`, tokenCount: 200, createdAtTurn: 5,
  });
  await chunkAndPersistMemory(id, slug, PROSE(`QUOTE-${slug}`, quote), { targetTokens: 400, maxTokens: 800, minTokens: 5 });
  return id;
}

// Role-aware scripted model.
export function scripted(opts: { badQuotes?: boolean; unsupportedModel?: boolean } = {}) {
  const calls: SynthRequest[] = [];
  const synth = new MockSynthesizer((req) => {
    calls.push(req);
    if (req.role === 'extract') {
      const blocks = req.prompt.split(/WINDOW (W\d+)/).slice(1);
      const windows: unknown[] = [];
      for (let i = 0; i < blocks.length; i += 2) {
        const id = blocks[i];
        const body = blocks[i + 1];
        const m = body.match(/QUOTE-([\w-]+): ([^\n]+)/);
        const facts = m
          ? (opts.badQuotes
              ? Array.from({ length: 45 }, (_, k) => ({ text: `Invented fact number ${k} about the setup.`, kind: 'convention', applies: 'global', entities: ['x'], quote: `this quote was never said anywhere ${k} ${k}` }))
              : [{ text: m[2].replace(/\.$/, '') + '.', kind: 'convention', when: '', applies: 'global', entities: ['AWS CLI'], quote: m[2].replace(/\.$/, '') }])
          : [];
        windows.push({ id, facts });
      }
      return JSON.stringify({ windows });
    }
    if (req.role === 'verify') {
      if (req.prompt.includes('DOCUMENT TO CHECK')) {
        return JSON.stringify(opts.unsupportedModel ? { supported: false, unsupported: ['made-up claim'] } : { supported: true, unsupported: [] });
      }
      const ids = [...req.prompt.matchAll(/ITEM (V\d+)/g)].map(m => m[1]);
      return JSON.stringify({ verdicts: ids.map(id => ({ id, supported: true, why: 'ok' })) });
    }
    if (req.role === 'consolidate') {
      const facts = [...req.prompt.matchAll(/^(F\d+) \[(\w+), [\d-]+\] (.+)$/gm)].map(m => ({ id: m[1], text: m[3] }));
      return JSON.stringify({ ops: facts.map(f => ({
        op: 'create', text: f.text, facet: 'convention', subject: 'environment', facts: [f.id],
        considered: [], reason: 'no existing observation covers this convention',
      })) });
    }
    if (req.role === 'model') {
      const obs = [...req.prompt.matchAll(/^(O\d+) \[observation/gm)].map(m => m[1]);
      return `## Conventions\nStanding conventions for this machine ${obs.slice(0, 3).map(o => `[${o}]`).join(' ')}.\n\n## Notes\nThese were compiled from the verified observations above and apply across projects [${obs[0] ?? 'O1'}].`;
    }
    if (req.role === 'name') return JSON.stringify({ worthy: false, covered_by: '', name: '', question: '', reason: 'test' });
    throw new Error(`unexpected role ${req.role}`);
  });
  return { synth, calls };
}

