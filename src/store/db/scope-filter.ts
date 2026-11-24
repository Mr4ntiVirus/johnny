// Read-side scope matching for knowledge retrieval (facts, observations, models).
//
// Knowledge is tagged with the git root (or cwd) of the session it came from. A session started in a
// non-git WORKSPACE directory (e.g. ~/dev, which holds many sibling projects) must also see what was
// learned in those projects' own scopes (~/dev/streaming system, ~/dev/johnny, ...), otherwise the
// project knowledge is invisible from the place the user actually works. A git-root scope stays strict
// (no leakage between sibling repos).
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScopeFilter { clause: string; params: string[] }

const LIKE_ESCAPE = /[\\%_]/g;

export function isWorkspaceScope(scope: string): boolean {
  if (!scope || scope === 'global' || !path.isAbsolute(scope)) return false;
  try { return !fs.existsSync(path.join(scope, '.git')); } catch { return false; }
}

/** SQL for "rows visible from `scope`": itself + global, plus descendant scopes for a non-git workspace. */
export function retrievalScopeFilter(scope: string, column = 'scope'): ScopeFilter {
  if (!isWorkspaceScope(scope)) return { clause: `(${column} = ? OR ${column} = ?)`, params: [scope, 'global'] };
  const like = scope.replace(/\/+$/, '').replace(LIKE_ESCAPE, m => '\\' + m) + '/%';
  return { clause: `(${column} = ? OR ${column} = ? OR ${column} LIKE ? ESCAPE '\\')`, params: [scope, 'global', like] };
}
