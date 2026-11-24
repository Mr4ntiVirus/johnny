// Smoke tests for the pre-compact hook. The handler is a thin stdin/stdout
// shell around trim(), so these check the glue — not trim behavior itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { runPreCompact } from '../../src/cli/pre-compact.js';

// Capture stdout writes for assertion without redirecting globally.
function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any) => {
      buf += chunk.toString();
      return true;
    };
    fn()
      .then(() => {
        process.stdout.write = original;
        resolve(buf);
      })
      .catch(err => {
        process.stdout.write = original;
        reject(err);
      });
  });
}

async function withStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
  // pre-compact reads stdin; feed it a synthetic stream.
  const { Readable } = await import('node:stream');
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([input]),
  });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'stdin', original);
  }
}

describe('runPreCompact', () => {
  useTestDb();

  let tmpHome: string;
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-pc-home-'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-pc-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    for (const d of [tmpHome, tmpDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('returns {} on invalid JSON stdin', async () => {
    const out = await captureStdout(() => withStdin('not-json', runPreCompact));
    expect(out).toBe('{}');
  });

  it('returns {} when payload lacks transcript_path', async () => {
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ session_id: 'x' }), runPreCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} for transcripts below the 600KB trim floor', async () => {
    const tiny = path.join(tmpDir, 'small.jsonl');
    fs.writeFileSync(tiny, '{"type":"user","content":"hi"}\n');
    const out = await captureStdout(() =>
      withStdin(
        JSON.stringify({ transcript_path: tiny, session_id: 'small-sess' }),
        runPreCompact,
      ),
    );
    expect(out).toBe('{}');
  });
});
