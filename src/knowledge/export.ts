// Knowledge pages: compiled mental models mirrored as plain markdown files under
// ~/.johnny/knowledge/<scope>/<slug>.md (YAML frontmatter + the model text), so
// Claude and the user can `grep`/read them directly with ordinary tools.
// Regenerated automatically after each synthesis run; archived models' files are
// removed. The database stays the source of truth — these files are a projection
// (deleting them is harmless: the next run re-creates them).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as modelsDb from '../store/db/mental-models.js';

export const knowledgeDir = () => path.join(os.homedir(), '.johnny', 'knowledge');

export const scopeDirName = (scope: string): string =>
  scope === 'global' ? 'global' : scope.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'scope';

export function renderModelPage(m: modelsDb.ModelRecord): string {
  const q = (s: string) => JSON.stringify(s);
  return [
    '---',
    `name: ${q(m.name)}`,
    `slug: ${m.slug}`,
    `scope: ${q(m.scope)}`,
    `answers: ${q(m.source_query)}`,
    `refreshed: ${m.last_refreshed_at ?? ''}`,
    `built_from: ${modelsDb.modelBasedOn(m).length}`,
    `origin: ${m.origin}`,
    '---',
    '',
    `# ${m.name}`,
    '',
    m.content ?? '',
    '',
  ].join('\n');
}

/** Write pages for active models, remove pages of models that are gone/archived. Returns counts. */
export async function exportModelPages(dir = knowledgeDir()): Promise<{ written: number; removed: number }> {
  const active = (await modelsDb.listModels({ status: 'active' })).filter(m => m.content);
  const wanted = new Set<string>();
  let written = 0;
  for (const m of active) {
    const file = path.join(dir, scopeDirName(m.scope), `${m.slug}.md`);
    wanted.add(file);
    const body = renderModelPage(m);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf-8') !== body) { fs.writeFileSync(file, body); written++; }
  }
  let removed = 0;
  if (fs.existsSync(dir)) {
    for (const scopeDir of fs.readdirSync(dir)) {
      const full = path.join(dir, scopeDir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        const file = path.join(full, f);
        if (f.endsWith('.md') && !wanted.has(file)) { fs.rmSync(file); removed++; }
      }
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    }
  }
  return { written, removed };
}
