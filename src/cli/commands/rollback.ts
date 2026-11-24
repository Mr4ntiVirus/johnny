import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { readIndex } from '../../vendor/cmv/core/metadata-store.js';
import { getCmvSnapshotsDir } from '../../vendor/cmv/utils/paths.js';
import { getLatestSession, getSessionJsonlPath } from '../../vendor/cmv/core/session-reader.js';
import { atomicWriteJsonl, readJsonlLines } from '../../utils/jsonl.js';
import { neon, ink, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

export async function cmdRollback(): Promise<void> {
  const index = await readIndex();
  const autoSnaps = Object.values(index.snapshots)
    .filter(s => s.tags.includes('johnny-auto'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (autoSnaps.length === 0) {
    process.stderr.write(neon.red('× no auto-snapshots. nothing to roll back to.\n'));
    await log('× no auto-snapshots');
    process.exit(1);
  }

  const latest = autoSnaps[0];
  const localJsonl = path.join(
    getCmvSnapshotsDir(),
    latest.snapshot_dir,
    'session',
    `${latest.source_session_id}.jsonl`,
  );

  const snapJsonl = localJsonl;
  const tmpPath: string | null = null;
  if (!existsSync(localJsonl)) {
    process.stderr.write(neon.red(`× snapshot file not found: ${latest.name}\n`));
    await log(`× snapshot not found: ${latest.name}`);
    process.exit(1);
  }

  const session = await getLatestSession();
  if (!session) {
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
    process.stderr.write(neon.red('× no active session found.\n'));
    await log('× no active session');
    process.exit(1);
  }

  const targetPath = getSessionJsonlPath(session);
  const lines = await readJsonlLines(snapJsonl);
  await atomicWriteJsonl(targetPath, lines);
  if (tmpPath) await fs.unlink(tmpPath).catch(() => {});

  process.stderr.write(neon.magenta(`⟳ rolled back · ${latest.name}\n`));
  await log(`⟳ rolled back · ${latest.name}`);
  process.stderr.write(dim.fg(`  ${latest.created_at.slice(0, 16)}\n`));
}
