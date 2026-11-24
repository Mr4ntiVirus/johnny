// Re-home already-compiled knowledge under the current scopeForProject() rule. Scopes are
// only labels (git root / project marker root / 'global'), so moving rows is safe and
// idempotent. Models that land in the same scope as a near-identical sibling are merged
// automatically by the next synthesis run (mergeOverlappingModels).

import { query, execute } from '../store/db-client.js';
import { scopeForProject } from './windows.js';

export interface RescopeResult { scopesChanged: number; facts: number; observations: number; models: number; changes: string[] }

export async function rescopeKnowledge(): Promise<RescopeResult> {
  const scopes = new Set<string>();
  for (const t of ['facts', 'observations', 'mental_models']) {
    for (const r of await query<{ scope: string }>(`SELECT DISTINCT scope FROM ${t}`)) scopes.add(r.scope);
  }
  const res: RescopeResult = { scopesChanged: 0, facts: 0, observations: 0, models: 0, changes: [] };
  for (const scope of scopes) {
    if (scope === 'global' || !scope.startsWith('/')) continue;
    const next = scopeForProject(scope);
    if (next === scope) continue;
    res.scopesChanged++;
    res.changes.push(`${scope} → ${next}`);
    for (const [table, key] of [['facts', 'facts'], ['observations', 'observations'], ['mental_models', 'models']] as const) {
      const n = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE scope = ?`, [scope]);
      await execute(`UPDATE ${table} SET scope = ? WHERE scope = ?`, [next, scope]);
      (res as unknown as Record<string, number>)[key] += Number(n[0]?.n) || 0;
    }
  }
  // consolidate watermarks are per scope: facts moved into a scope with its own watermark must
  // be re-seen, so drop the target-scope watermarks of moved scopes and let consolidation redo them.
  if (res.scopesChanged > 0) await execute(`DELETE FROM job_state WHERE job = 'consolidate'`);
  return res;
}
