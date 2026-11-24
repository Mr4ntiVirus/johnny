import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { heartbeatScript, plistXml, installHeartbeatFiles, LABEL, INTERVAL_SECONDS, scriptPath, plistPath } from '../../src/knowledge/heartbeat.js';

describe('synthesis heartbeat files', () => {
  let tmp: string; let oldHome: string | undefined;
  beforeEach(() => { oldHome = process.env.HOME; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-hb-')); process.env.HOME = tmp; });
  afterEach(() => { process.env.HOME = oldHome; });

  it('the wrapper does a free precheck, skips quietly when idle or offline, and only then runs a governed pass', () => {
    const s = heartbeatScript();
    expect(s.indexOf('johnny synth status --exit-code')).toBeLessThan(s.indexOf('johnny synth run'));
    expect(s).toMatch(/-eq 75 \] && exit 0/);          // nothing pending => exit before any model call
    expect(s).toContain('api.anthropic.com');          // offline => skip, retry next heartbeat
    expect(s).not.toMatch(/dangerously|iTerm|osascript/); // headless, no window, no permission bypass
  });

  it('plist is a plain interval LaunchAgent (no window, background priority)', () => {
    const x = plistXml();
    expect(x).toContain(`<string>${LABEL}</string>`);
    expect(x).toContain(`<integer>${INTERVAL_SECONDS}</integer>`);
    expect(x).toContain('<key>RunAtLoad</key>');
    expect(x).toContain('<string>Background</string>');
    expect(INTERVAL_SECONDS).toBe(10800);
  });

  it('install writes both files executable-ready and never loads anything', () => {
    const r = installHeartbeatFiles();
    expect(r.script).toBe(scriptPath());
    expect(r.plist).toBe(plistPath());
    expect(fs.statSync(r.script).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(r.plist, 'utf-8')).toContain(r.script);
    expect(r.plist.startsWith(tmp)).toBe(true); // wrote under the (temp) HOME only
  });
});
