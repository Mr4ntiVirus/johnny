import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useLocalSqlite } from '../helpers/sqlite.js';
import { retrievalScopeFilter, isWorkspaceScope } from '../../src/store/db/scope-filter.js';
import { claimDate, pickNewerFacts, formatDigest } from '../../src/knowledge/prime.js';
import type { KnowledgeHit } from '../../src/knowledge/retrieve.js';
import * as factsDb from '../../src/store/db/facts.js';
import * as obsDb from '../../src/store/db/observations.js';

const hit = (o: Partial<KnowledgeHit>): KnowledgeHit => ({
  kind: 'observation', ref: 'obs:1', title: 't', text: 'x', scope: 'global', score: 0.8, similarity: 0.74,
  asOf: '2026-10-13T00:00:00Z', stale: false, proof: 2, disputed: false, verified: true, ...o,
});

describe('retrievalScopeFilter', () => {
  let root: string;
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-ws-'))); });

  it('a git-root scope stays strict (no sibling leakage)', () => {
    fs.mkdirSync(path.join(root, '.git'));
    expect(isWorkspaceScope(root)).toBe(false);
    expect(retrievalScopeFilter(root).clause).not.toContain('LIKE');
  });
  it('a non-git workspace scope also matches its descendant scopes', () => {
    expect(isWorkspaceScope(root)).toBe(true);
    const f = retrievalScopeFilter(root);
    expect(f.clause).toContain('LIKE');
    expect(f.params).toEqual([root, 'global', root + '/%']);
  });
  it('global and relative scopes are never treated as workspaces', () => {
    expect(isWorkspaceScope('global')).toBe(false);
    expect(isWorkspaceScope('relative/dir')).toBe(false);
  });
});

describe('workspace scope retrieval from the stores', () => {
  useLocalSqlite();
  it('facts/observations in child project scopes are visible from the workspace, siblings stay hidden from a git repo', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-ws2-')));
    const repo = path.join(root, 'repoA'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const child = path.join(root, 'child proj');
    await factsDb.createFact({ scope: child, text: 'child fact', kind: 'state' });
    await factsDb.createFact({ scope: repo, text: 'repo fact', kind: 'state' });
    await factsDb.createFact({ scope: 'global', text: 'global fact', kind: 'state' });
    await obsDb.createObservation({ scope: child, text: 'child obs' });

    const fromWorkspace = (await factsDb.listActiveFacts(root, 100, undefined, true)).map(f => f.text).sort();
    expect(fromWorkspace).toEqual(['child fact', 'global fact', 'repo fact']);
    const fromRepo = (await factsDb.listActiveFacts(repo, 100, undefined, true)).map(f => f.text).sort();
    expect(fromRepo).toEqual(['global fact', 'repo fact']);
    // Default (maintenance) behaviour is unchanged: exact scope only.
    expect((await factsDb.listActiveFacts(root, 100)).length).toBe(0);
    expect((await obsDb.listActiveObservations(root, 100, true)).map(o => o.text)).toEqual(['child obs']);
    expect((await obsDb.listActiveObservations(root, 100)).length).toBe(0);
  });
});

describe('newer-facts attachment for dated observations', () => {
  it('claimDate parses an explicit "As of" date only', () => {
    expect(claimDate('As of 2026-05-07, the timers were off.')).toBe('2026-05-07');
    expect(claimDate('The relay listens on 8443.')).toBeNull();
  });
  it('picks newer, same-subject facts, newest first; ignores older/weak/undated cases', () => {
    const obs = hit({ text: 'As of 2026-05-07, timers were disabled.', similarity: 0.742 });
    const f = (id: string, asOf: string, sim: number) => hit({ kind: 'fact', ref: `fact:${id}`, asOf, similarity: sim, text: id });
    const picked = pickNewerFacts(obs, [
      f('older', '2026-04-01T00:00:00Z', 0.8), f('weak', '2026-09-22T00:00:00Z', 0.6),
      f('sep', '2026-09-22T00:00:00Z', 0.78), f('aug', '2026-08-20T00:00:00Z', 0.75),
      f('oct', '2026-10-01T00:00:00Z', 0.70), f('extra', '2026-08-01T00:00:00Z', 0.76),
    ]);
    expect(picked.map(p => p.text)).toEqual(['oct', 'sep', 'aug']);
    expect(pickNewerFacts(hit({ text: 'undated claim' }), [f('sep', '2026-09-22T00:00:00Z', 0.9)])).toEqual([]);
  });
  it('formatDigest labels newer notes as superseding', () => {
    const out = formatDigest([hit({ text: 'As of 2026-05-07, x.' })], 'q', 2000,
      [hit({ kind: 'fact', ref: 'fact:a', text: 'Fix deployed: MIN_FREE_GB 10.', asOf: '2026-09-22T00:00:00Z' })]);
    expect(out).toContain('NEWER notes');
    expect(out).toContain('MIN_FREE_GB 10');
    expect(out).toContain('noted 2026-09-22');
  });
});
