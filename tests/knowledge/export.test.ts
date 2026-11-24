import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useLocalSqlite } from '../helpers/sqlite.js';
import * as modelsDb from '../../src/store/db/mental-models.js';
import { exportModelPages, renderModelPage, scopeDirName } from '../../src/knowledge/export.js';

describe('knowledge page export', () => {
  useLocalSqlite();
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-kp-')); });

  const make = async (slug: string, scope: string, content: string | null) => {
    await modelsDb.createModel({ slug, name: `Model ${slug}`, sourceQuery: `What is ${slug}?`, scope });
    if (content) await modelsDb.writeModelContent(slug, content, ['obs-1'], '2026-10-12T00:00:00.000Z', 't');
  };

  it('maps scopes to safe directory names', () => {
    expect(scopeDirName('global')).toBe('global');
    expect(scopeDirName('/home/alice/dev/johnny')).toBe('home_alice_dev_johnny');
    expect(scopeDirName('/')).toBe('scope');
  });

  it('writes one markdown page per compiled model with frontmatter, and only changes what changed', async () => {
    await make('relay', '/home/alice/dev/johnny', '## Network\nPort 8443.');
    await make('conventions', 'global', '## Platform\nmacOS has no timeout.');
    await make('empty', 'global', null); // not compiled yet: no page
    const r = await exportModelPages(dir);
    expect(r).toEqual({ written: 2, removed: 0 });
    const page = fs.readFileSync(path.join(dir, 'home_alice_dev_johnny', 'relay.md'), 'utf-8');
    expect(page).toMatch(/^---\nname: "Model relay"\nslug: relay\nscope: "\/home\/alice\/dev\/johnny"/);
    expect(page).toContain('answers: "What is relay?"');
    expect(page).toContain('# Model relay');
    expect(page).toContain('Port 8443.');
    expect(fs.existsSync(path.join(dir, 'global', 'empty.md'))).toBe(false);
    expect((await exportModelPages(dir)).written).toBe(0); // idempotent
  });

  it('removes pages for archived models and prunes empty scope directories', async () => {
    await make('gone', '/p/x', '## A\ntext here for the model');
    await exportModelPages(dir);
    expect(fs.existsSync(path.join(dir, 'p_x', 'gone.md'))).toBe(true);
    await modelsDb.setModelStatus('gone', 'archived');
    const r = await exportModelPages(dir);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(dir, 'p_x'))).toBe(false);
  });

  it('renderModelPage escapes quotes in frontmatter', async () => {
    await modelsDb.createModel({ slug: 'q', name: 'The "quoted" one', sourceQuery: 'a: b', scope: 'global' });
    const m = (await modelsDb.getModelBySlug('q'))!;
    expect(renderModelPage(m)).toContain('name: "The \\"quoted\\" one"');
  });
});
