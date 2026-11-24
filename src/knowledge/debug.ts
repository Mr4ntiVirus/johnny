// Bounded debug capture for model replies the pipeline could not use. Lives in
// ~/.johnny/synth-debug/ (never in the memory store); oldest files are pruned so
// it cannot grow without bound. Content is secret-redacted before it is written.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactSecrets } from './redact.js';

const MAX_FILES = 40;
const MAX_CHARS = 6000;

export const debugDir = () => path.join(os.homedir(), '.johnny', 'synth-debug');

export function dumpDebug(kind: string, parts: Record<string, string>): string | null {
  if (process.env.JOHNNY_LLM_MOCK) return null; // tests must never write into the real ~/.johnny
  try {
    const dir = debugDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.txt`);
    const body = Object.entries(parts)
      .map(([k, v]) => `=== ${k} ===\n${redactSecrets(v).slice(0, MAX_CHARS)}`).join('\n\n');
    fs.writeFileSync(file, body);
    const files = fs.readdirSync(dir).sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_FILES))) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  } catch { return null; }
}
