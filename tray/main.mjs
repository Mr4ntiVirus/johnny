// Johnny menu-bar tray. Polls `johnny doctor --json` and shows a compact status menu.
// Optional companion to `johnny doctor`; it holds no data of its own.
import { app, Tray, Menu, nativeImage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { trayTitle, menuRows } from './lib/summary.mjs';

const POLL_MS = 5000;
let tray = null;
let snapshot = null;
let busy = false;

function run(args) {
  return new Promise(resolve => {
    execFile('johnny', args, { timeout: 15000, env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const out = await run(['doctor', '--json']);
    try { snapshot = out ? JSON.parse(out) : null; } catch { snapshot = null; }
  } finally {
    busy = false;
  }
  render();
}

function openDoctorInTerminal() {
  // Opens Terminal.app running the live dashboard.
  execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', 'tell application "Terminal" to do script "johnny doctor"']);
}

function render() {
  if (!tray) return;
  tray.setTitle(trayTitle(snapshot));
  const items = menuRows(snapshot).map(r => ({ label: r.label, enabled: false }));
  items.push(
    { type: 'separator' },
    { label: 'Open doctor in Terminal', click: openDoctorInTerminal },
    { label: 'Restart daemon', click: async () => { await run(['doctor', '--restart-daemon']); refresh(); } },
    { label: 'Open ~/.johnny', click: () => shell.openPath(`${process.env.HOME}/.johnny`) },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  tray = new Tray(nativeImage.createEmpty());
  render();
  refresh();
  setInterval(refresh, POLL_MS);
});

app.on('window-all-closed', e => e.preventDefault());
