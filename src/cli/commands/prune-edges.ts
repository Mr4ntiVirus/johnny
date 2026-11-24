import { readConfig } from '../../store/config.js';
import { closeDatabase } from '../../store/database.js';
import {
  getTotalEdgeCount,
  pruneOutgoingEdgesOverCap,
  countOutgoingEdgesOverCap,
} from '../../store/db/edges.js';
import { neon, dim } from '../../brand/tokens.js';

const HELP = `
  ${neon.cyan('johnny prune-edges')} — prune edges over the topKOutgoing cap

  ${dim.fg('usage:')}
    johnny prune-edges            ${dim.fg('# delete all excess edges and report')}
    johnny prune-edges --dry-run  ${dim.fg('# preview without mutating')}
    johnny prune-edges --json     ${dim.fg('# machine-readable JSON output')}
    johnny prune-edges --help     ${dim.fg('# this message')}

  Keeps the top-${dim.fg('topKOutgoing')} outgoing edges per source memory (by weight,
  ties broken by id). Run --dry-run first to preview the impact.
`;

export async function cmdPruneEdges(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  try {
    const config = await readConfig();
    const cap = config.topKOutgoing;

    const edgesBefore = await getTotalEdgeCount();
    const edgesOverCap = await countOutgoingEdgesOverCap(cap);

    if (dryRun) {
      const result = {
        dryRun: true,
        cap,
        edgesBefore,
        edgesOverCap,
        edgesAfterIfRun: edgesBefore - edgesOverCap,
      };
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(`${neon.cyan('prune-edges')} ${dim.fg('dry run')}\n`);
        process.stdout.write(`  cap (topKOutgoing):  ${cap}\n`);
        process.stdout.write(`  edges before:        ${edgesBefore}\n`);
        process.stdout.write(`  edges over cap:      ${edgesOverCap}\n`);
        process.stdout.write(`  edges after if run:  ${edgesBefore - edgesOverCap}\n`);
        process.stdout.write(`\n${dim.fg('run without --dry-run to delete excess edges')}\n`);
      }
      return;
    }

    const edgesDeleted = await pruneOutgoingEdgesOverCap(cap);
    const edgesAfter = await getTotalEdgeCount();

    const result = {
      dryRun: false,
      cap,
      edgesBefore,
      edgesDeleted,
      edgesAfter,
    };

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(`${neon.cyan('prune-edges')} ${neon.green('done')}\n`);
      process.stdout.write(`  cap (topKOutgoing):  ${cap}\n`);
      process.stdout.write(`  edges before:        ${edgesBefore}\n`);
      process.stdout.write(`  edges deleted:       ${edgesDeleted}\n`);
      process.stdout.write(`  edges after:         ${edgesAfter}\n`);
    }
  } finally {
    closeDatabase();
  }
}
