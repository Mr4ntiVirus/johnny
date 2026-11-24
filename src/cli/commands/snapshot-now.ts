// Force an immediate snapshot of the active session.
// Used by the /snapshot slash command when the user wants a manual checkpoint.
import { getLatestSession, getSessionJsonlPath } from '../../vendor/cmv/core/session-reader.js';
import { readSessionMap } from '../../store/session-map.js';
import { readState } from '../../store/state.js';
import { snapshot } from '../../actions/snapshot.js';
import { neon, dim } from '../../brand/tokens.js';
import { log } from '../../utils/log.js';

export async function cmdSnapshotNow(): Promise<void> {
  const session = await getLatestSession();
  if (!session) {
    process.stdout.write(neon.red('× no active session · nothing to snapshot\n'));
    await log('× no active session');
    process.exit(1);
  }

  const transcriptPath = getSessionJsonlPath(session);
  const sessionMap = await readSessionMap();
  const state = await readState();

  // Prefer sessionId from session-map (authoritative) over CMV's latest
  const sessionId = sessionMap.activeSessionId ?? (session as any).sessionId ?? 'unknown';
  const entry = sessionId ? sessionMap.sessions[sessionId] : null;
  const cwd = entry?.lastCwd ?? '';

  const { snapshotName } = await snapshot(transcriptPath, sessionId, cwd, state.turnCounter, false);

  if (snapshotName) {
    process.stdout.write(neon.cyan(`◈ snapshot saved · ${snapshotName}\n`));
    await log(`◈ snapshot saved · ${snapshotName}`);
    process.stdout.write(dim.fg('  use /recall to surface it in a future session\n'));
  } else {
    process.stdout.write(neon.red('× snapshot failed · check ~/.johnny/johnny.log\n'));
    await log('× snapshot failed');
  }
}
