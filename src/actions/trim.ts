import * as fs from 'node:fs/promises';
import { trimJsonl } from '../vendor/cmv/core/trimmer.js';
import type { HookOutput } from '../types.js';
import { log } from '../utils/log.js';
import { neon, ink, dim } from '../brand/tokens.js';

export async function trim(transcriptPath: string): Promise<HookOutput> {
  const tmp = transcriptPath + '.johnny-trim.tmp';
  try {
    const metrics = await trimJsonl(transcriptPath, tmp, {});
    await fs.rename(tmp, transcriptPath);
    const origK = Math.round(metrics.originalBytes / 1024);
    const trimK = Math.round(metrics.trimmedBytes / 1024);
    await log(`trim: ${origK}k → ${trimK}k bytes from ${transcriptPath}`);
    return { systemMessage: neon.green('▞▞▞') + ink.fg(` context trimmed · ${origK}k → ${trimK}k`) };
  } catch (err) {
    await fs.rm(tmp, { force: true });
    await log(`trim ERROR: ${err}`);
    return { systemMessage: neon.red('×') + dim.fg(' trim failed · falling back') };
  }
}
