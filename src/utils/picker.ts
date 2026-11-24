// Full-width context picker — opens /dev/tty, enters the terminal's alternate
// screen buffer, renders a BBS-framed picker, and restores the primary buffer
// on exit. Alt-screen isolation means Claude Code's TUI repaints cannot bleed
// through. Resizes with the window via SIGWINCH + 'resize' event + a poll
// fallback (hooks are spawned outside the terminal's foreground process group,
// so SIGWINCH is not always delivered to us).
import { openSync, writeSync, closeSync } from 'node:fs';
import * as tty from 'node:tty';
import { log } from './log.js';
import { neon, dim, ink } from '../brand/tokens.js';

export type PickerChoice =
  | { kind: 'candidate'; index: number }
  | { kind: 'stay' }
  | { kind: 'cancel' };

export interface PickerOption {
  label: string;
  hint?: string;
}

const ESC = '\x1b';
const CSI = `${ESC}[`;
const HIDE_CURSOR    = `${CSI}?25l`;
const SHOW_CURSOR    = `${CSI}?25h`;
const ALT_SCREEN_ON  = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const CLEAR_SCREEN   = `${CSI}2J`;
const HOME           = `${CSI}H`;
const goto = (row: number, col: number) => `${CSI}${row};${col}H`;

// Strip ANSI sequences for printable-width measurement.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const visibleLen = (s: string) => stripAnsi(s).length;

export function pickerAvailable(): boolean {
  // Inside Claude Code, its TUI is also reading /dev/tty. Two readers on the
  // same terminal without tcsetpgrp arbitration means keystrokes race, and
  // Claude's TUI wins arrow keys (cycling prompt history) while repainting
  // over our alt-screen. Fall back to stderr + exit(2) numbered list instead.
  if (process.env.CLAUDECODE === '1') return false;
  try {
    const fd = openSync('/dev/tty', 'r+');
    const isTTY = tty.isatty(fd);
    closeSync(fd);
    return isTTY;
  } catch {
    return false;
  }
}

export async function runPicker(
  header: string,
  options: PickerOption[],
): Promise<PickerChoice> {
  let readFd: number;
  let writeFd: number;
  try {
    readFd = openSync('/dev/tty', 'r');
    writeFd = openSync('/dev/tty', 'w');
  } catch (err) {
    await log(`picker: cannot open /dev/tty: ${err}`);
    return { kind: 'cancel' };
  }

  if (!tty.isatty(readFd) || !tty.isatty(writeFd)) {
    try { closeSync(readFd); closeSync(writeFd); } catch { /* ignore */ }
    return { kind: 'cancel' };
  }

  const input  = new tty.ReadStream(readFd);
  const output = new tty.WriteStream(writeFd);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  const items: { kind: 'candidate' | 'stay'; index?: number; label: string; hint?: string }[] = [
    ...options.map((o, i) => ({ kind: 'candidate' as const, index: i, label: o.label, hint: o.hint })),
    { kind: 'stay' as const, label: 'stay in current context' },
  ];

  let cursor = 0;
  let lastCols = 0;
  let lastRows = 0;

  const render = () => {
    const cols = output.columns ?? 80;
    const rows = output.rows ?? 24;
    lastCols = cols;
    lastRows = rows;

    // Inner width between the `+|` and `|+` frame chars. Clamp generously so
    // narrow panes still produce a readable box.
    const innerW = Math.max(20, cols - 4);

    // Horizontal rules. Colored; length measured as visible chars.
    const topRule = neon.cyan('+|' + '-'.repeat(innerW) + '|+');
    const botRule = neon.cyan('+|' + '='.repeat(innerW) + '|+');
    const divRule = dim.fg( '|'  + '-'.repeat(innerW + 2) + '|');

    // A blank content row: left rail, padding, right rail. Padding fills to
    // `innerW + 2` visible chars inside the rails.
    const blankRow = () =>
      dim.fg('|') + ' '.repeat(innerW + 2) + dim.fg('|');

    // Build a content row: left rail `|  `, content, padding to align right rail.
    const contentRow = (text: string): string => {
      const vis = visibleLen(text);
      const pad = Math.max(0, innerW - vis);
      // 2 spaces of left gutter (already accounted: innerW + 2 total between rails)
      return dim.fg('|') + '  ' + text + ' '.repeat(pad) + dim.fg('|');
    };

    // Assemble body lines
    const body: string[] = [];
    body.push(blankRow());
    body.push(contentRow(neon.amber(header)));
    body.push(blankRow());
    body.push(divRule);
    body.push(blankRow());

    for (let i = 0; i < items.length; i++) {
      const sel = i === cursor;
      const marker = sel ? neon.cyan('›') : ' ';
      // Every row gets a number: candidates = 1..N, stay = N+1
      const shortcut = items[i].kind === 'candidate'
        ? (items[i].index ?? 0) + 1
        : options.length + 1;
      const num = dim.fg(`${shortcut}.`) + ' ';
      const labelStr = sel
        ? neon.amber(items[i].label)
        : ink.fg(items[i].label);
      body.push(contentRow(` ${marker}  ${num}${labelStr}`));
      if (items[i].hint) {
        body.push(contentRow(`        ${dim.fg(items[i].hint!)}`));
      }
    }

    body.push(blankRow());
    body.push(divRule);
    body.push(blankRow());
    body.push(contentRow(dim.fg('↑/↓ · 1-9 · enter · esc to cancel')));
    body.push(blankRow());

    // Vertically center within the viewport
    const totalHeight = body.length + 2; // + top/bottom rules
    const startRow = Math.max(1, Math.floor((rows - totalHeight) / 2) + 1);

    // Paint: clear, then place frame at the centered row.
    let out = CLEAR_SCREEN + HOME + goto(startRow, 1) + topRule + '\n';
    for (let i = 0; i < body.length; i++) {
      out += goto(startRow + 1 + i, 1) + body[i] + '\n';
    }
    out += goto(startRow + 1 + body.length, 1) + botRule;
    writeSync(writeFd, out);
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { writeSync(writeFd, SHOW_CURSOR + ALT_SCREEN_OFF); } catch { /* ignore */ }
    try { input.setRawMode(false); } catch { /* ignore */ }
    try { input.pause(); input.destroy(); } catch { /* ignore */ }
    try { closeSync(writeFd); } catch { /* ignore */ }
    try { process.off('SIGWINCH', onResize); } catch { /* ignore */ }
    try { output.off('resize', onResize); } catch { /* ignore */ }
    if (pollTimer) clearInterval(pollTimer);
  };

  const onResize = () => { if (!cleaned) render(); };

  // Three layers of resize detection so we stay pixel-perfect even when SIGWINCH
  // isn't delivered (hook is a subprocess, not always in the TTY's foreground
  // process group).
  process.on('SIGWINCH', onResize);
  output.on('resize', onResize);
  const pollTimer = setInterval(() => {
    if (cleaned) return;
    const cols = output.columns ?? 80;
    const rows = output.rows ?? 24;
    if (cols !== lastCols || rows !== lastRows) render();
  }, 200);

  // Fatal-signal cleanup so we don't leave the terminal in alt-screen + raw mode
  const onSignal = () => { cleanup(); process.exit(130); };
  process.once('SIGINT',  onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP',  onSignal);
  process.once('exit', cleanup);

  writeSync(writeFd, ALT_SCREEN_ON + HIDE_CURSOR);
  render();

  return new Promise<PickerChoice>(resolve => {
    const onKey = (key: string) => {
      // Enter
      if (key === '\r' || key === '\n') {
        input.off('data', onKey);
        cleanup();
        const chosen = items[cursor];
        if (chosen.kind === 'stay') return resolve({ kind: 'stay' });
        return resolve({ kind: 'candidate', index: chosen.index! });
      }

      // Ctrl-C, Esc, q
      if (key === '\x03' || key === ESC || key === 'q' || key === 'Q') {
        input.off('data', onKey);
        cleanup();
        return resolve({ kind: 'cancel' });
      }

      // Arrow up / k
      if (key === `${CSI}A` || key === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
        return;
      }
      // Arrow down / j
      if (key === `${CSI}B` || key === 'j') {
        cursor = (cursor + 1) % items.length;
        render();
        return;
      }

      // Number shortcuts 1-9 — jump AND select.
      // 1..options.length → candidate; options.length+1 → stay.
      const numMatch = key.match(/^([1-9])$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx < options.length) {
          input.off('data', onKey);
          cleanup();
          return resolve({ kind: 'candidate', index: idx });
        }
        if (idx === options.length) {
          input.off('data', onKey);
          cleanup();
          return resolve({ kind: 'stay' });
        }
      }
    };

    input.on('data', onKey);
  });
}
