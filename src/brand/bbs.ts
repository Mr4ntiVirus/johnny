// BBS terminal layout primitives — inspired by 90s hacker bulletin board aesthetics.
// Left-rail `|` on every content line, `+|---...|+` outer frame, `||--|--|` tables.
import { neon, dim } from './tokens.js';

type ColorFn = (s: string) => string;

// Frame width adapts to the current terminal so it never wraps in narrow panes
// (e.g. after an iTerm2 split). Clamped so the box still has a sensible shape
// on very small or very wide terminals.
export function getWidth(): number {
  const cols = process.stdout.columns ?? process.stderr.columns ?? 80;
  return Math.max(40, Math.min(74, cols - 6));
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export function top(): string     { return neon.cyan('+|' + '-'.repeat(getWidth()) + '|-+'); }
export function bot(): string     { return neon.cyan('+|' + '='.repeat(getWidth()) + '|=+'); }
export function div(): string     { return dim.fg( '|' + '-'.repeat(getWidth() + 2) + '|'); }
export function divBold(): string { return neon.cyan('|' + '='.repeat(getWidth() + 2) + '|'); }

// ── Content rows ──────────────────────────────────────────────────────────────

export function row(s = ''): string {
  return dim.fg('|') + '  ' + s;
}

export function section(label: string): string {
  return dim.fg('|') + neon.cyan(`== ${label.toUpperCase()} ==`);
}

export function field(key: string, value: string, valueColor?: ColorFn): string {
  const v = valueColor ? valueColor(value) : value;
  return dim.fg('|') + dim.fg(key.padEnd(12)) + v;
}

export function menuItem(n: number | string, cmd: string, color?: ColorFn): string {
  const label = color ? color('/' + cmd) : dim.fg('/' + cmd);
  return dim.fg('|') + `  (${n}) ` + label;
}

export function hint(text: string, author = 'JOHNNY'): string {
  return dim.fg('|') + neon.amber(`HINT: ${text} -${author}`);
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function tableHeader(cols: { label: string; width: number }[]): string[] {
  const bar = dim.fg('||') + cols.map(c => '-'.repeat(c.width + 2)).join(dim.fg('|')) + dim.fg('|');
  const hdr = dim.fg('||') + cols.map(c => neon.cyan(` ${c.label.toUpperCase().padEnd(c.width)} `)).join(dim.fg('|')) + dim.fg('|');
  return [bar, hdr, bar];
}

export function tableRow(cells: { value: string; width: number; color?: ColorFn }[], active = false): string {
  const star = active ? neon.amber(' * ') : '   ';
  return dim.fg('|') + star + dim.fg('|') +
    cells.map(c => {
      const v = c.color ? c.color(c.value) : dim.fg(c.value);
      return ` ${v} `;
    }).join(dim.fg('|')) + dim.fg('|');
}

export function tableFooter(cols: { width: number }[]): string {
  return dim.fg('||') + cols.map(c => '-'.repeat(c.width + 2)).join(dim.fg('|')) + dim.fg('|');
}

// ── Printing helpers ──────────────────────────────────────────────────────────

const w = (s: string) => process.stdout.write(s + '\n');

export function printTop(): void    { w(top()); }
export function printBot(): void    { w(bot()); }
export function printDiv(): void    { w(div()); }
export function printRow(s = ''): void   { w(row(s)); }
export function printSection(label: string): void { w(section(label)); }
export function printField(key: string, value: string, vc?: ColorFn): void { w(field(key, value, vc)); }
export function printMenu(n: number | string, cmd: string, color?: ColorFn): void { w(menuItem(n, cmd, color)); }
export function printHint(text: string, author?: string): void { w(hint(text, author)); }
