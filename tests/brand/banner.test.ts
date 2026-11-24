import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { printHookBanner } from '../../src/brand/banner.js';
import { useTestDb } from '../helpers/db.js';

const ANSI_RE = /\x1b\[/;

describe('printHookBanner · TTY/NO_COLOR safety', () => {
  useTestDb();

  let captured = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  const origIsTTY = process.stderr.isTTY;
  const origNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    captured = '';
    (process.stderr.write as any) = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, configurable: true });
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  });

  it('emits no ANSI escapes when stderr is not a TTY', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    delete process.env.NO_COLOR;
    await printHookBanner();
    expect(captured).toContain('JOHNNY ONLINE');
    expect(captured).not.toMatch(ANSI_RE);
  });

  it('emits no ANSI escapes when NO_COLOR is set, even on a TTY', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    process.env.NO_COLOR = '1';
    await printHookBanner();
    expect(captured).toContain('JOHNNY ONLINE');
    expect(captured).not.toMatch(ANSI_RE);
  });
});
