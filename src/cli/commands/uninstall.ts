import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getClaudeSettingsPath, getClaudeBaseDir } from '../../vendor/cmv/utils/paths.js';
import { readJsonFile, writeJsonFile } from '../../utils/jsonl.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

const execFileAsync = promisify(execFile);
const SLASH_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'slash-commands');

/** Remove the slash commands install copied, but only the ones the user has not edited. */
export async function removeSlashCommands(srcDir: string = SLASH_SRC): Promise<number> {
  const commandsDir = path.join(getClaudeBaseDir(), 'commands');
  let removed = 0;
  let files: string[] = [];
  try { files = await fs.readdir(srcDir); } catch { return 0; }
  for (const f of files.filter(n => n.endsWith('.md'))) {
    try {
      const [shipped, installed] = await Promise.all([
        fs.readFile(path.join(srcDir, f), 'utf-8'),
        fs.readFile(path.join(commandsDir, f), 'utf-8'),
      ]);
      if (shipped === installed) { await fs.unlink(path.join(commandsDir, f)); removed++; }
    } catch { /* not installed or unreadable: leave it */ }
  }
  return removed;
}

async function removeMcpServer(): Promise<boolean> {
  try {
    await execFileAsync('claude', ['mcp', 'remove', 'johnny', '--scope', 'user']);
    return true;
  } catch { return false; }
}

export async function cmdUninstall(): Promise<void> {
  const slash = await removeSlashCommands();
  const mcp = await removeMcpServer();
  try { (await import('../../knowledge/heartbeat.js')).removeHeartbeat(); } catch { /* not installed */ }
  if (slash > 0) process.stderr.write(dim.fg(`  slash: ${slash} command(s) removed\n`));
  if (mcp) process.stderr.write(dim.fg('  mcp: johnny server removed\n'));
  const settingsPath = getClaudeSettingsPath();
  const settings = (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const before = (hooks[event] as unknown[]).length;
    hooks[event] = (hooks[event] as unknown[]).filter((e: unknown) =>
      !(e as any).hooks?.some((h: any) => typeof h.command === 'string' && h.command.startsWith('johnny'))
    );
    if (hooks[event].length === 0) delete hooks[event];
    removed += before - ((hooks[event] ?? []) as unknown[]).length;
  }

  if (removed === 0) {
    process.stderr.write(ink.fg('  hooks not found · already unwired\n'));
    return;
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;

  await writeJsonFile(settingsPath, settings);
  process.stderr.write(neon.amber(`◎ unwired · ${removed} hook(s) removed\n`));
  await log(`◎ unwired · ${removed} hook(s) removed`);
  process.stderr.write(dim.fg('  re-install: johnny install\n'));
}
