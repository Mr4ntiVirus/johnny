import * as fs from 'node:fs/promises';
import { PATHS } from '../../store/paths.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

export async function cmdDisable(): Promise<void> {
  await fs.mkdir(PATHS.dir, { recursive: true });
  await fs.writeFile(PATHS.disabled, '');
  process.stderr.write(neon.amber('◎ bypassed. hooks pass through silently.\n'));
  await log('bypass: hooks pass through silently');
  process.stderr.write(dim.fg('  re-enable: johnny enable\n'));
  process.stderr.write(dim.fg('  per-session: JOHNNY_BYPASS=1 claude\n'));
}

export async function cmdEnable(): Promise<void> {
  try {
    await fs.rm(PATHS.disabled);
    process.stderr.write(neon.cyan('◈ back on.\n'));
    await log('bypass: back on');
  } catch {
    process.stderr.write(ink.fg('  already on.\n'));
  }
}
