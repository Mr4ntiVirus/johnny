// johnny models — override / diagnostic surface for mental models. Models are
// created, refreshed, merged and archived automatically; nothing here is ever
// a required step. (`add` lets you force a standing question into existence.)

import { readKnowledgeConfig } from '../../knowledge/config.js';
import { ClaudeCliSynthesizer } from '../../knowledge/synth.js';
import { refreshModel, modelIsStale } from '../../knowledge/refresh.js';
import * as modelsDb from '../../store/db/mental-models.js';
import * as hist from '../../store/db/knowledge-history.js';
import { embed, getEmbedModelName } from '../../utils/llm.js';
import { scopeForProject } from '../../knowledge/windows.js';

const arg = (args: string[], name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const out = (m: string) => process.stdout.write(m + '\n');

export async function cmdModels(args: string[]): Promise<void> {
  const [sub = 'list', ...rest] = args;

  if (sub === 'list') {
    const models = await modelsDb.listModels();
    if (models.length === 0) { out('no models yet — they are built automatically once enough observations exist.'); return; }
    for (const m of models) {
      out(`${m.slug.padEnd(40)} ${m.status.padEnd(9)} ${m.scope === 'global' ? 'global' : m.scope}  refreshed ${m.last_refreshed_at?.slice(0, 10) ?? '—'}${(await modelIsStale(m)) ? '  STALE' : ''}${m.paused ? '  PAUSED' : ''}`);
    }
    return;
  }

  const slug = rest[0];
  if (sub === 'show') {
    const m = slug ? await modelsDb.getModelBySlug(slug) : null;
    if (!m) { out(`no model "${slug}"`); process.exit(1); }
    out(`${m.name} (${m.slug}) · ${m.status} · scope ${m.scope}\nanswers: ${m.source_query}\n\n${m.content ?? '(not compiled yet)'}`);
    if (rest.includes('--history')) {
      for (const h of await hist.getHistory('model', m.id, 10)) out(`\n--- v${h.version} ${h.created_at.slice(0, 16)} (${h.reason}) ---\n${(h.content ?? '').slice(0, 600)}`);
    }
    return;
  }

  if (sub === 'refresh') {
    const m = slug ? await modelsDb.getModelBySlug(slug) : null;
    if (!m) { out(`no model "${slug}"`); process.exit(1); }
    const cfg = await readKnowledgeConfig();
    const res = await refreshModel(new ClaudeCliSynthesizer({ defaultModel: cfg.synth.defaultModel, models: cfg.synth.models }), m.slug, { force: rest.includes('--force') });
    out(JSON.stringify(res));
    return;
  }

  if (sub === 'archive') {
    if (!slug) { out('usage: johnny models archive <slug>'); process.exit(1); }
    await modelsDb.setModelStatus(slug, 'archived');
    out(`archived ${slug}`);
    return;
  }

  if (sub === 'add') {
    const question = arg(rest, 'query');
    if (!slug || !question) { out('usage: johnny models add <slug> --query="standing question" [--scope=global|<path>]'); process.exit(1); }
    const scopeArg = arg(rest, 'scope');
    const scope = scopeArg && scopeArg !== 'global' ? scopeForProject(scopeArg) : 'global';
    let qe: number[] | null = null;
    try { qe = await embed(`${slug}. ${question}`); } catch { qe = null; }
    await modelsDb.createModel({
      slug, name: slug, sourceQuery: question, scope, origin: 'manual',
      queryEmbedding: qe, embeddingModel: qe ? getEmbedModelName() : null,
    });
    out(`created ${slug}; it will be compiled on the next background run`);
    return;
  }

  out('usage: johnny models <list|show <slug> [--history]|refresh <slug> [--force]|archive <slug>|add <slug> --query=...>');
  process.exit(1);
}
