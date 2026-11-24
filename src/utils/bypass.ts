import { existsSync } from 'node:fs';
import { PATHS } from '../store/paths.js';

// Returns true if Johnny should silently pass through.
// Triggers: JOHNNY_BYPASS=1 env var, or touch ~/.johnny/disabled
export function isBypassed(): boolean {
  return !!process.env.JOHNNY_BYPASS || existsSync(PATHS.disabled);
}

// Call at the top of every hook entry point before doing any work.
// Writes {} to stdout and exits 0 — Claude Code sees a clean no-op.
export function exitIfBypassed(): void {
  if (isBypassed()) {
    process.stdout.write('{}');
    process.exit(0);
  }
}
