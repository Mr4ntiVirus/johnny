import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs module outside the TypeScript project
import { trayTitle, menuRows } from '../../tray/lib/summary.mjs';

const base = {
  bypassed: false, daemonAlive: true, daemonPid: 123, ollamaUp: true,
  graphStats: { totalMemories: 42 }, memoriesLastDay: 3, recallsLastDay: 5,
  knowledge: { facts: 10, observations: 4, models: 2, synth: { pendingMemories: 0 } },
  subsystems: [{ name: 'watcher', short: 'watch', status: 'ok' }],
};

describe('tray summary', () => {
  it('titles reflect health in priority order', () => {
    expect(trayTitle(null)).toBe('J ?');
    expect(trayTitle({ ...base, bypassed: true })).toBe('J ⏸');
    expect(trayTitle({ ...base, daemonAlive: false })).toBe('J ✗');
    expect(trayTitle({ ...base, ollamaUp: false })).toBe('J !');
    expect(trayTitle(base)).toBe('J ✓');
  });

  it('builds readable rows with no cloud or inbox entries', () => {
    const labels = menuRows(base).map((r: { label: string }) => r.label);
    expect(labels).toContain('Daemon: running (PID 123)');
    expect(labels).toContain('Memories: 42 (3 today, 5 recalls today)');
    expect(labels).toContain('Knowledge: 10 facts, 4 observations, 2 models');
    expect(labels.join(' ')).not.toMatch(/inbox|email|cloud|postgres/i);
  });

  it('flags pending synthesis and unhealthy subsystems', () => {
    const labels = menuRows({
      ...base,
      knowledge: { ...base.knowledge, synth: { pendingMemories: 7 } },
      subsystems: [{ name: 'watcher', short: 'watch', status: 'warn' }],
    }).map((r: { label: string }) => r.label);
    expect(labels).toContain('Synthesis pending: 7 memories');
    expect(labels).toContain('Subsystems needing attention: watch');
  });

  it('degrades when doctor is unavailable', () => {
    expect(menuRows(null)[0].label).toMatch(/unavailable/);
  });
});
