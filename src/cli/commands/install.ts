import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getClaudeSettingsPath, getClaudeBaseDir } from '../../vendor/cmv/utils/paths.js';
import { readJsonFile, writeJsonFile } from '../../utils/jsonl.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { printBanner } from '../../brand/banner.js';
import { log } from '../../utils/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// slash-commands/ lives 3 levels up from dist/cli/commands/
const SLASH_SRC = path.resolve(__dirname, '..', '..', '..', 'slash-commands');

// Hook timeouts (seconds). Hooks run on Claude Code's interactive path, so they are short.
const timeout = (seconds: number): number => seconds;

const JOHNNY_HOOKS = {
  UserPromptSubmit: [{
    matcher: '',
    hooks: [{ type: 'command', command: 'johnny evaluate', timeout: timeout(30) }],
  }],
  PreCompact: [{
    matcher: '',
    hooks: [{ type: 'command', command: 'johnny pre-compact', timeout: timeout(30) }],
  }],
  PostCompact: [{
    matcher: '',
    hooks: [{ type: 'command', command: 'johnny post-compact', timeout: timeout(30) }],
  }],
  PostToolUse: [{
    matcher: '',
    hooks: [{ type: 'command', command: 'johnny post-turn --check-size', timeout: timeout(10) }],
  }],
};

// Opt-in (`johnny install --tool-prime`): mid-turn knowledge priming for shell commands.
// Claude Code attaches PreToolUse context next to the tool RESULT, so it can only prevent
// repeats within a turn (never the first failing call), and registering it costs a node
// start (~0.3s) on EVERY Bash call in every session — so it is not part of the default install.
const OPTIONAL_HOOKS = {
  PreToolUse: [{
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'johnny pre-tool', timeout: timeout(5) }],
  }],
};

const execFileAsync = promisify(execFile);

// Registered via `claude mcp add --scope user`, NOT written into
// ~/.claude/settings.json — Claude Code resolves MCP servers from
// project-scoped entries in ~/.claude.json (or --scope user for a
// global entry), and silently ignores a top-level `mcpServers` key in
// settings.json. An earlier version of this installer wrote there,
// which meant the johnny_* tools were never
// actually reachable from any Claude Code session except one launched
// with cwd exactly at this repo (confirmed via `claude mcp list`).
// Bare command name, resolved via PATH (`npm link` puts `johnny` on PATH).
async function installMcpServer(): Promise<boolean> {
  try {
    // `claude mcp get` reports the scope of whatever entry is active for the
    // *current* cwd — a project-local entry (e.g. one added by hand while
    // working inside this repo) would satisfy this check and mask the fact
    // that no user-scope entry exists, so doctor-launched sessions (which run
    // from an arbitrary cwd) would still come up empty. Only a User-scope
    // hit means it's actually available everywhere.
    const { stdout } = await execFileAsync('claude', ['mcp', 'get', 'johnny']);
    if (/Scope:\s*User/i.test(stdout)) {
      return false; // already registered at user scope — nothing to do
    }
  } catch {
    // not registered at all for this cwd — fall through and attempt add
  }
  try {
    await execFileAsync('claude', [
      'mcp', 'add', 'johnny', '--scope', 'user',
      '--', 'johnny', 'mcp',
    ]);
    return true;
  } catch (err) {
    process.stderr.write(dim.fg(`  mcp: failed to register johnny server — ${err}\n`));
    return false;
  }
}

async function installSlashCommands(): Promise<void> {
  const commandsDir = path.join(getClaudeBaseDir(), 'commands');
  await fs.mkdir(commandsDir, { recursive: true });

  let files: string[];
  try {
    files = await fs.readdir(SLASH_SRC);
  } catch {
    // slash-commands dir not present (e.g. running from dist only)
    return;
  }

  for (const f of files.filter(f => f.endsWith('.md'))) {
    const src  = path.join(SLASH_SRC, f);
    const dest = path.join(commandsDir, f);
    await fs.copyFile(src, dest);
  }
}

export async function cmdInstall(args: string[] = []): Promise<void> {
  const hooksToInstall: Record<string, typeof JOHNNY_HOOKS[keyof typeof JOHNNY_HOOKS]> = {
    ...JOHNNY_HOOKS,
    ...(args.includes('--tool-prime') ? OPTIONAL_HOOKS : {}),
  };
  const settingsPath = getClaudeSettingsPath();
  const settings = (await readJsonFile<Record<string, unknown>>(settingsPath)) ?? {};
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};

  let changed = false;
  for (const [event, entries] of Object.entries(hooksToInstall)) {
    const existing = (hooks[event] as unknown[]) ?? [];
    const targetCmd = (entries[0]?.hooks?.[0] as any)?.command as string;
    const targetTimeout = (entries[0]?.hooks?.[0] as any)?.timeout as number;
    // Matches on command only (timeout excluded) so a bumped timeout value in
    // JOHNNY_HOOKS is detected as a real change below, not silently ignored —
    // this previously reported "hooks already wired" and skipped the update
    // even when the installed timeout was stale, since only the command
    // string was compared.
    const installedEntry = existing.find((e: unknown) =>
      (e as any).hooks?.some((h: any) => typeof h.command === 'string' && h.command === targetCmd)
    ) as any;
    const installedTimeout = installedEntry?.hooks?.find((h: any) => h.command === targetCmd)?.timeout;
    const hasJohnny = !!installedEntry && installedTimeout === targetTimeout;
    if (!hasJohnny) {
      // Drop any existing entry for this exact command (stale timeout or
      // otherwise) before re-adding the current definition, so re-running
      // install never leaves two copies of Johnny's own hook registered.
      const withoutStale = existing.filter((e: unknown) =>
        !(e as any).hooks?.some((h: any) => typeof h.command === 'string' && h.command === targetCmd)
      );
      hooks[event] = [...entries, ...withoutStale];
      changed = true;
    }
  }

  // MCP registration is NOT part of settings.json — see installMcpServer().
  // Only clean up a stale top-level `mcpServers` key left by an older
  // version of this installer; Claude Code never read it.
  const hadStaleMcpKey = 'mcpServers' in settings;
  if (hadStaleMcpKey) {
    delete settings.mcpServers;
    changed = true;
  }

  const mcpInstalled = await installMcpServer();
  if (mcpInstalled) {
    process.stderr.write(dim.fg('  mcp: johnny registered at user scope\n'));
  }

  // Always (re)install slash commands — idempotent
  await installSlashCommands();

  if (!changed) {
    process.stderr.write(ink.fg('  hooks already wired.\n'));
    return;
  }

  settings.hooks = hooks;
  await writeJsonFile(settingsPath, settings);

  await printBanner();
  process.stderr.write(neon.cyan('◈ wired in.\n'));
  await log('◈ wired in');
  process.stderr.write(dim.fg('  claude: UserPromptSubmit · PreCompact · PostCompact · PostToolUse\n'));
  process.stderr.write(dim.fg('  slash: /recall · /snapshot · /jstatus\n'));
  process.stderr.write(dim.fg('  mcp: johnny (johnny_remember · johnny_search · johnny_recall · johnny_list · johnny_graph · johnny_invalidate)\n'));
  process.stderr.write(dim.fg('  bypass: johnny disable  ·  remove: johnny uninstall\n'));
}
