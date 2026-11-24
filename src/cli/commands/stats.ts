// johnny stats --json — machine-readable DoctorSnapshot dump.
// Same data contract as `johnny doctor`'s TUI (see src/store/stats.ts);
// consumed by docker/terminal-server/server.js to feed the web dashboard.
import { collectStats, decorateLogLine, statusGlyph, SUBSYSTEM_INTERVALS, type DecoratedLine } from '../../store/stats.js';
import { writeSync } from 'node:fs';

export async function cmdStats(args: string[]): Promise<void> {
  if (!args.includes('--json')) {
    process.stderr.write('johnny stats: only --json output is supported. Use `johnny doctor` for the interactive dashboard.\n');
    process.exit(1);
  }
  const snapshot = await collectStats();

  // Decorate log lines and heartbeat status glyphs here rather than in
  // collectStats() itself — the TUI (doctor.tsx) does its own decoration at
  // render time and doesn't want this baked in, but a JSON consumer has no
  // equivalent decorator table to reimplement, so bake it in for that path.
  const decoratedLog: DecoratedLine[] = snapshot.recentLogLines
    .map(decorateLogLine)
    .filter((d): d is DecoratedLine => d !== null);
  const beats = new Map(snapshot.heartbeats.map(b => [b.subsystem, b]));
  const subsystemStatus = Object.keys(SUBSYSTEM_INTERVALS).map(name => ({
    name,
    ...statusGlyph(beats.get(name), name),
  }));

  // fs.writeSync(1, ...), not process.stdout.write() + process.exit(). On
  // POSIX, Node writes to a *pipe* stdout asynchronously (writes to files or
  // TTYs are synchronous, pipes are not — see Node's process.stdout docs) —
  // exactly what execFile uses to capture this command's output in
  // terminal-server.js. process.exit() right after write() truncated output
  // almost every run; even gating exit on write()'s own callback still
  // truncated some runs, since the callback firing doesn't guarantee the
  // full payload reached the pipe's reader. writeSync is a real blocking
  // syscall — it only returns once the write is actually complete, sidestepping
  // the async-pipe issue entirely rather than racing against it.
  writeSync(1, JSON.stringify({ ...snapshot, decoratedLog, subsystemStatus }));

}
