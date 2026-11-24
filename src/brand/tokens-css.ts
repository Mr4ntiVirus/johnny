// Generates src/brand/tokens.css from the same hex values as tokens.ts.
// Run via: node dist/brand/tokens-css.js > src/brand/tokens.css
// Used by johnny graph --export html and the future Hosted Johnny web portal.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = `/* Johnny brand tokens — generated from src/brand/tokens.ts. DO NOT EDIT BY HAND. */
/* Re-generate: node dist/brand/tokens-css.js > src/brand/tokens.css              */

:root {
  /* Neon — primary identity colors */
  --neon-cyan:    #00FFE0;
  --neon-magenta: #FF2EA6;
  --neon-green:   #00FF66;
  --neon-amber:   #FFB000;
  --neon-red:     #FF3860;

  /* Ink — structure and text */
  --ink-black:    #0A0C10;
  --ink-grid:     #1A1F2C;
  --ink-fg:       #D8E4FF;
  --ink-dim:      #4A5568;

  /* Semantic aliases */
  --color-primary:    var(--neon-cyan);
  --color-accent:     var(--neon-magenta);
  --color-success:    var(--neon-green);
  --color-warning:    var(--neon-amber);
  --color-error:      var(--neon-red);
  --color-bg:         var(--ink-black);
  --color-surface:    var(--ink-grid);
  --color-text:       var(--ink-fg);
  --color-text-muted: var(--ink-dim);

  /* Typography */
  --font-mono: 'JetBrains Mono', 'Berkeley Mono', 'Fira Code', 'Cascadia Code', monospace;
}

/* Base cyberpunk reset */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-mono);
}

/* Utility classes */
.neon-cyan    { color: var(--neon-cyan); }
.neon-magenta { color: var(--neon-magenta); }
.neon-green   { color: var(--neon-green); }
.neon-amber   { color: var(--neon-amber); }
.neon-red     { color: var(--neon-red); }
.text-muted   { color: var(--color-text-muted); }
.text-dim     { color: var(--ink-dim); }
.bg-surface   { background: var(--color-surface); }

/* Glow effects — use sparingly (≤15% saturated pixel budget) */
.glow-cyan    { text-shadow: 0 0 8px var(--neon-cyan); }
.glow-magenta { text-shadow: 0 0 8px var(--neon-magenta); }
`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', '..', 'src', 'brand', 'tokens.css');

await fs.writeFile(OUT, CSS, 'utf-8');
process.stdout.write(`tokens.css written → ${OUT}\n`);
