// johnny dump — display the current active Claude session as a readable transcript.
// Shows last N exchanges; --raw for full JSON.
import { getLatestSession, getSessionJsonlPath } from '../../vendor/cmv/core/session-reader.js';
import { readJsonlLines } from '../../utils/jsonl.js';
import { Spinner } from '../../utils/spinner.js';
import { neon, ink, dim } from '../../brand/tokens.js';

interface Entry {
  type?: string;
  role?: string;
  content?: unknown;
  summary?: string;
  message?: { role?: string; content?: unknown };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          if (o.type === 'text' && typeof o.text === 'string') return o.text;
          if (o.type === 'tool_use') return `[tool: ${o.name ?? '?'}]`;
          if (o.type === 'tool_result') return `[tool result: ${String(o.content ?? '').slice(0, 80)}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export async function cmdDump(args: string[]): Promise<void> {
  const rawMode  = args.includes('--raw');
  const nIdx     = args.indexOf('--lines');
  const maxLines = nIdx !== -1 ? parseInt(args[nIdx + 1] ?? '30', 10) : 30;

  const spinner = new Spinner();
  spinner.start('jacking into memory core...');

  const session = await getLatestSession();
  if (!session) {
    spinner.clear();
    process.stdout.write(neon.red('× no active session found\n'));
    process.exit(1);
  }

  const jsonlPath = getSessionJsonlPath(session);
  const lines = await readJsonlLines(jsonlPath);

  spinner.stop(neon.cyan('◈'), dim.fg(`session ${session.sessionId.slice(0, 8)}  ·  ${lines.length} entries`));

  if (rawMode) {
    process.stdout.write('\n');
    for (const line of lines.slice(-maxLines)) {
      process.stdout.write(JSON.stringify(line) + '\n');
    }
    return;
  }

  const entries = lines as Entry[];
  const slice = entries.slice(-maxLines);

  process.stdout.write('\n');
  process.stdout.write(
    neon.cyan('  ╔' + '═'.repeat(56) + '╗') + '\n' +
    neon.cyan('  ║') + dim.fg(`  context dump  ·  last ${slice.length} of ${entries.length}`) + '  '.padEnd(56 - 22 - String(slice.length).length - String(entries.length).length) + neon.cyan('║') + '\n' +
    neon.cyan('  ╚' + '═'.repeat(56) + '╝') + '\n\n'
  );

  for (const entry of slice) {
    const role    = entry.role ?? entry.message?.role ?? entry.type ?? 'unknown';
    const content = entry.content ?? entry.message?.content;

    if (entry.type === 'summary') {
      process.stdout.write(dim.fg(`  ··· ${entry.summary ?? ''} ···`) + '\n\n');
      continue;
    }

    const text = extractText(content).trim();
    if (!text) continue;

    const preview = text.length > 300 ? text.slice(0, 297) + '…' : text;

    if (role === 'human' || role === 'user') {
      process.stdout.write(neon.cyan('  ▸ you  ') + ink.fg(preview) + '\n\n');
    } else if (role === 'assistant') {
      process.stdout.write(neon.green('  ▸ ai   ') + dim.fg(preview) + '\n\n');
    } else {
      process.stdout.write(dim.fg(`  ▸ ${role.slice(0, 4).padEnd(4)} ${preview}`) + '\n\n');
    }
  }

  process.stdout.write(dim.fg(`  ── ${jsonlPath} ──`) + '\n');
  process.stdout.write(dim.fg('  flags: --lines N (default 30)  ·  --raw') + '\n\n');
}
