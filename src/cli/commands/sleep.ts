import { runConsolidation } from '../../sleep/index.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

export async function cmdSleep(): Promise<void> {
  process.stdout.write(neon.magenta('∎ sleeping · consolidating memory\n'));
  await log('∎ sleeping · consolidating memory');
  const report = await runConsolidation();
  if (!report) {
    process.stdout.write(ink.fg('  nothing to consolidate\n'));
    return;
  }
  process.stdout.write([
    dim.fg(`  turn:      ${report.turnAtConsolidation}`),
    dim.fg(`  schemas:   ${report.schemasCreated}`),
    dim.fg(`  latent:    ${report.latentEdgesAdded}`),
    dim.fg(`  pruned:    ${report.edgesPruned}`),
    dim.fg(`  archived:  ${report.memoriesArchived}`),
    dim.fg(`  duration:  ${report.durationMs}ms`),
    neon.cyan('◈ awake. rested.'),
    '',
  ].join('\n'));
  await log('◈ awake. rested');
}
