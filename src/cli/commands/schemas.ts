// `johnny schemas`              — list quarantined schema gist nodes
// `johnny schemas show <id>`    — full gist node: topics, members, summary
// `johnny schemas approve <id>` — move to recall pool (content_type → 'text')
// `johnny schemas reject <id>`  — delete the schema node permanently
import * as memoriesDb from '../../store/db/memories.js';
import * as transcriptsDb from '../../store/db/transcripts.js';
import { neon, dim } from '../../brand/tokens.js';
import { humanDate } from '../../utils/human-date.js';

export async function cmdSchemas(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const schemas = await memoriesDb.listSchemas();
    if (schemas.length === 0) {
      process.stdout.write('no quarantined schemas. run johnny sleep to synthesize.\n');
      return;
    }
    process.stdout.write(`${schemas.length} quarantined schema(s):\n\n`);
    for (const s of schemas) {
      const date = humanDate(s.created_at);
      process.stdout.write(
        neon.cyan(s.id.slice(0, 8)) +
        dim.fg(`  ${date}  `) +
        s.snapshot_name +
        (s.summary ? `\n  ${dim.fg(s.summary.slice(0, 100))}` : '') +
        '\n\n',
      );
    }
    process.stdout.write(`approve: johnny schemas approve <id>\nreject:  johnny schemas reject <id>\n`);
    return;
  }

  const id = args[1];
  if (!id) {
    process.stderr.write(`usage: johnny schemas ${sub} <id>\n`);
    process.exit(1);
  }

  if (sub === 'show') {
    const schemas = await memoriesDb.listSchemas();
    const schema = schemas.find(s => s.id === id || s.id.startsWith(id));
    if (!schema) {
      process.stderr.write(`schema not found: ${id}\n`);
      process.exit(1);
    }
    const transcript = await transcriptsDb.getTranscript(schema.id);
    const topics = transcript?.topics ? JSON.parse(transcript.topics) as string[] : [];
    process.stdout.write([
      neon.cyan(schema.snapshot_name),
      `id:       ${schema.id}`,
      `date:     ${humanDate(schema.created_at)}`,
      `topics:   ${topics.join(', ')}`,
      `summary:  ${schema.summary ?? '(none)'}`,
      '',
      'cluster members:',
      transcript?.transcript ?? '(no transcript)',
    ].join('\n') + '\n');
    return;
  }

  if (sub === 'approve') {
    const schemas = await memoriesDb.listSchemas();
    const schema = schemas.find(s => s.id === id || s.id.startsWith(id));
    if (!schema) {
      process.stderr.write(`schema not found: ${id}\n`);
      process.exit(1);
    }
    await memoriesDb.approveSchema(schema.id);
    process.stdout.write(`approved: ${schema.snapshot_name} — now in recall pool\n`);
    return;
  }

  if (sub === 'reject') {
    const schemas = await memoriesDb.listSchemas();
    const schema = schemas.find(s => s.id === id || s.id.startsWith(id));
    if (!schema) {
      process.stderr.write(`schema not found: ${id}\n`);
      process.exit(1);
    }
    await memoriesDb.rejectSchema(schema.id);
    process.stdout.write(`rejected: ${schema.snapshot_name} — deleted\n`);
    return;
  }

  process.stderr.write(`unknown subcommand: ${sub}\njohnny schemas [list|show|approve|reject]\n`);
  process.exit(1);
}
