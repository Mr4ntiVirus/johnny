import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const LOG_FILE = path.join(os.homedir(), '.johnny', 'johnny.log');

// Test-suite muzzle. Vitest sets VITEST=true; we also honor JOHNNY_LOG_SUPPRESS
// for any other harness. Tests run the real evaluate.ts/snapshot.ts/etc. with
// :memory: DBs but the log file is global — without this, every test run
// pollutes ~/.johnny/johnny.log with entries that look like real session
// activity in `johnny watch`.
const SUPPRESS_LOG =
  process.env.VITEST === 'true' ||
  process.env.NODE_ENV === 'test' ||
  process.env.JOHNNY_LOG_SUPPRESS === '1';

export async function log(msg: string): Promise<void> {
  if (SUPPRESS_LOG) return;
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    await fs.appendFile(LOG_FILE, line);
  } catch {
    // if log dir doesn't exist yet, swallow — don't let logging crash the hook
  }
}
