import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useLocalSqlite } from '../helpers/sqlite.js';
import { scopeForProject } from '../../src/knowledge/windows.js';
import { rescopeKnowledge } from '../../src/knowledge/rescope.js';
import * as factsDb from '../../src/store/db/facts.js';
import * as obsDb from '../../src/store/db/observations.js';
import * as modelsDb from '../../src/store/db/mental-models.js';

describe('scopeForProject', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-scope-'))); });
  const mk = (p: string, files: string[] = []) => { const d = path.join(root, p); fs.mkdirSync(d, { recursive: true }); for (const f of files) fs.writeFileSync(path.join(d, f), f === '.git' ? '' : '{}'); return d; };

  it('git root wins, including from a deep subdirectory', () => {
    mk('repo', ['.git']);
    const deep = mk('repo/lambda/x');
    expect(scopeForProject(deep)).toBe(path.join(root, 'repo'));
  });
  it('without git, climbs to the nearest project marker so app sub-dirs do not fragment', () => {
    mk('app', ['package.json']);
    expect(scopeForProject(mk('app/bin'))).toBe(path.join(root, 'app'));
    expect(scopeForProject(mk('app/jobs.d'))).toBe(path.join(root, 'app'));
  });
  it('no markers anywhere: the path itself; empty: global; climb is bounded', () => {
    expect(scopeForProject(mk('plain/sub'))).toBe(path.join(root, 'plain/sub'));
    expect(scopeForProject('')).toBe('global');
    mk('far', ['package.json']);
    expect(scopeForProject(mk('far/a/b/c/d/e'))).toBe(path.join(root, 'far/a/b/c/d/e')); // > 3 levels up: not adopted
  });
});

describe('rescopeKnowledge', () => {
  useLocalSqlite();
  it('moves facts/observations/models from fragment scopes to the project scope, idempotently', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-rescope-')));
    fs.mkdirSync(path.join(root, 'app/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app/package.json'), '{}');
    const frag = path.join(root, 'app/bin');
    await factsDb.createFact({ scope: frag, text: 'a fact', kind: 'state' });
    await obsDb.createObservation({ scope: frag, text: 'an observation about the app bin dir' });
    await modelsDb.createModel({ slug: 'bin-overview', name: 'bin', sourceQuery: 'q', scope: frag });
    await factsDb.createFact({ scope: 'global', text: 'stays global', kind: 'state' });

    const r = await rescopeKnowledge();
    expect(r).toMatchObject({ scopesChanged: 1, facts: 1, observations: 1, models: 1 });
    expect((await factsDb.listActiveFacts(path.join(root, 'app'))).map(f => f.text)).toEqual(['a fact']);
    expect((await modelsDb.getModelBySlug('bin-overview'))!.scope).toBe(path.join(root, 'app'));
    expect((await factsDb.listActiveFacts('global')).length).toBe(1);
    expect((await rescopeKnowledge()).scopesChanged).toBe(0);
  });
});
