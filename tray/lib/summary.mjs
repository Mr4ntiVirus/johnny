// Pure helpers: turn one `johnny doctor --json` snapshot into the tray's title and menu rows.
// No Electron imports here so this can be unit-tested.

/** Short text shown next to the menu-bar icon. */
export function trayTitle(snap) {
  if (!snap) return 'J ?';
  if (snap.bypassed) return 'J ⏸';
  if (!snap.daemonAlive) return 'J ✗';
  if (!snap.ollamaUp) return 'J !';
  return 'J ✓';
}

/** Menu rows as plain {label} objects; the Electron side adds actions. */
export function menuRows(snap) {
  if (!snap) return [{ label: 'doctor unavailable (is `johnny` on your PATH?)' }];
  const rows = [];
  rows.push({ label: snap.bypassed ? 'Hooks: bypassed' : 'Hooks: active' });
  rows.push({ label: snap.daemonAlive ? `Daemon: running (PID ${snap.daemonPid})` : 'Daemon: stopped' });
  rows.push({ label: snap.ollamaUp ? 'Ollama: up' : 'Ollama: not reachable' });
  const total = snap.graphStats?.totalMemories ?? 0;
  rows.push({ label: `Memories: ${total} (${snap.memoriesLastDay ?? 0} today, ${snap.recallsLastDay ?? 0} recalls today)` });
  const k = snap.knowledge;
  if (k) {
    rows.push({ label: `Knowledge: ${k.facts} facts, ${k.observations} observations, ${k.models} models` });
    if (k.synth?.pendingMemories > 0) rows.push({ label: `Synthesis pending: ${k.synth.pendingMemories} memories` });
  }
  const bad = (snap.subsystems ?? []).filter(s => s.status === 'warn' || s.status === 'error');
  if (bad.length) rows.push({ label: `Subsystems needing attention: ${bad.map(s => s.short ?? s.name).join(', ')}` });
  return rows;
}
