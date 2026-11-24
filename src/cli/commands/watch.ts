// `johnny watch` — live colorized tail of ~/.johnny/johnny.log.
// Enhanced with view switching via --view flag.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { PATHS } from '../../store/paths.js';
import { neon, ink, dim } from '../../brand/tokens.js';

const POLL_MS = 200;
const DEFAULT_HISTORY = 20;

type Decorator = { test: RegExp; glyph: string; color: (s: string) => string; noise?: boolean };

const DECORATORS: Decorator[] = [
  { test: /ERROR|error:|FATAL/,           glyph: '×',    color: neon.red     },
  { test: /^trim:/,                        glyph: '▞▞▞',  color: neon.green   },
  { test: /^pre-compact:/,                 glyph: '▞',    color: neon.green   },
  { test: /^snapshot:/,                    glyph: '◈',    color: neon.cyan    },
  { test: /^recommend:/,                   glyph: '⇌',    color: neon.cyan    },
  { test: /^suggest:/,                     glyph: '⇌⇌',   color: neon.cyan    },
  { test: /^hard-switch:/,                 glyph: '⟳',    color: neon.magenta },
  { test: /^recall /,                      glyph: '↺',    color: neon.cyan    },
  { test: /^bootstrap:/,                   glyph: '⎆',    color: neon.cyan    },
  { test: /^sleep(\/|:)/,                  glyph: '☾',    color: neon.amber   },
  { test: /^(daemon|watcher|model-warmer|rank-refresher|idle):/, glyph: '⚙', color: neon.amber },
  { test: /^action=passthrough/,           glyph: '·',    color: dim.fg,      noise: true },
  { test: /^action=/,                      glyph: '▶',    color: ink.fg       },
  { test: /^(evaluate |turn=|classifier|heuristics|merged )/, glyph: '○', color: dim.fg, noise: true },
  { test: /^post-turn:/,                   glyph: '⌁',    color: dim.fg,      noise: true },
];

function shortTime(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : iso.slice(0, 8);
}

function decorate(line: string, verbose: boolean): string | null {
  if (!line) return null;
  const sp = line.indexOf(' ');
  if (sp === -1) return line;
  const ts = line.slice(0, sp);
  const rest = line.slice(sp + 1);

  const dec = DECORATORS.find(d => d.test.test(rest));
  if (dec?.noise && !verbose) return null;

  const glyph = dec ? dec.glyph : ' ';
  const color = dec ? dec.color : dim.fg;

  return `${dim.fg(shortTime(ts))}  ${color(glyph.padEnd(3))} ${color(rest)}`;
}

function parseLines(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--lines') && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return DEFAULT_HISTORY;
}

function parseVerbose(args: string[]): boolean {
  return args.includes('-v') || args.includes('--verbose');
}

async function printHistory(lines: number, verbose: boolean): Promise<void> {
  if (lines === 0) return;
  try {
    const raw = await fsp.readFile(PATHS.log, 'utf8');
    const all = raw.split('\n').filter(Boolean);
    const kept: string[] = [];
    for (let i = all.length - 1; i >= 0 && kept.length < lines; i--) {
      const d = decorate(all[i], verbose);
      if (d !== null) kept.unshift(d);
    }
    for (const l of kept) process.stdout.write(l + '\n');
  } catch {
    // log doesn't exist yet
  }
}

function printHeader(verbose: boolean): void {
  const bar = dim.fg('─'.repeat(60));
  const mode = verbose ? dim.fg('verbose · all events') : dim.fg('actions only · -v for verbose');
  process.stdout.write(bar + '\n');
  process.stdout.write(
    `  ${neon.amber('JOHNNY')}  ${dim.fg('watching')}  ${mode}\n`
  );
  process.stdout.write(bar + '\n');
}

export async function cmdWatch(args: string[]): Promise<void> {
  const historyLines = parseLines(args);
  const verbose = parseVerbose(args);
  printHeader(verbose);
  await printHistory(historyLines, verbose);

  let offset = 0;
  try {
    const st = await fsp.stat(PATHS.log);
    offset = st.size;
  } catch {
    // file missing
  }

  let partial = '';
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(dim.fg('\n─ watch ended ─\n'));
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  const tick = async () => {
    if (stopping) return;
    try {
      const st = await fsp.stat(PATHS.log);
      if (st.size < offset) {
        offset = 0;
        partial = '';
      }
      if (st.size > offset) {
        const fd = await fsp.open(PATHS.log, 'r');
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, offset);
          offset = st.size;
          const chunk = partial + buf.toString('utf8');
          const lines = chunk.split('\n');
          partial = lines.pop() ?? '';
          for (const l of lines) {
            if (!l) continue;
            const d = decorate(l, verbose);
            if (d !== null) process.stdout.write(d + '\n');
          }
        } finally {
          await fd.close();
        }
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        // non-fatal
      }
    }
  };

  const loop = () => {
    if (stopping) return;
    void tick().finally(() => {
      if (!stopping) setTimeout(loop, POLL_MS);
    });
  };
  loop();

  await new Promise<void>(() => {});
}