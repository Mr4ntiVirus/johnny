import * as readline from 'node:readline';
import { readState } from '../../store/state.js';
import { addMemory } from '../../store/memory.js';
import { embedMemory } from '../../engine/embedder.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

function extractTopics(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter(w => w.length > 3)
    .slice(0, 20);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

async function promptQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

export async function cmdRemember(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      `\n  ${neon.cyan('johnny remember')} — save a memory manually\n\n` +
      `  ${dim.fg('usage:')}\n` +
      `    johnny remember "<title>" --content="<text>"   ${dim.fg('# one-shot')}\n` +
      `    johnny remember "<title>"                      ${dim.fg('# prompts for content on stdin')}\n` +
      `    johnny remember                                ${dim.fg('# prompts for both')}\n` +
      `    johnny remember --help                         ${dim.fg('# this message')}\n`,
    );
    return;
  }

  let title = '';
  let transcript = '';

  const titleArg = args.find(a => !a.startsWith('--'));
  const contentArg = args.find(a => a.startsWith('--content='));

  if (titleArg) {
    title = titleArg;
  }

  if (contentArg) {
    transcript = contentArg.replace('--content=', '').replace(/^["']|["']$/g, '');
  }

  if (!title) {
    process.stderr.write(dim.fg('Creating a new memory in Johnny\'s graph.\n'));
    title = await promptQuestion('Title: ');
  }

  if (!transcript) {
    process.stderr.write(dim.fg('Enter the memory content (press Ctrl+D when done):\n'));
    const chunks: string[] = [];
    process.stderr.write(dim.fg('> '));

    for await (const chunk of process.stdin) {
      const trimmed = chunk.toString().trim();
      if (trimmed === 'done' || trimmed === '.done') break;
      if (trimmed) chunks.push(trimmed);
      process.stderr.write(dim.fg('> '));
    }
    transcript = chunks.join('\n');
  }

  if (!title || !transcript) {
    process.stderr.write(neon.red('× Title and transcript are required.\n'));
    process.exit(1);
  }

  const snapshotName = slugify(title);
  const topics = extractTopics(transcript);
  const tokenCount = estimateTokens(transcript);

  try {
    const state = await readState();
    const mem = await addMemory(
      snapshotName,
      title,
      title, // summary = title (exact transcript preserved separately)
      transcript,
      process.cwd(),
      tokenCount,
      topics,
      state.turnCounter,
    );

    // Best-effort embed so the memory becomes retrievable via similarity search.
    try { await embedMemory(mem); } catch { /* Ollama offline — deferred */ }

    await log(`memory: created ${snapshotName} (${tokenCount} tokens)`);

    process.stderr.write(neon.cyan('◈') + ink.fg(' memory saved') + neon.cyan(` · ${snapshotName}\n`));
    process.stderr.write(dim.fg(`  ${topics.slice(0, 5).join(', ')}\n`));
  } catch (err) {
    process.stderr.write(neon.red(`× failed to save memory: ${err}\n`));
    await log(`memory ERROR: ${err}`);
  }
}
