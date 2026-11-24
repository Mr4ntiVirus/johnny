import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('uninstall: slash commands', () => {
  let tmp: string; let oldHome: string | undefined;
  beforeEach(() => {
    oldHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-un-'));
    process.env.HOME = tmp;
  });
  afterEach(() => { process.env.HOME = oldHome; fs.rmSync(tmp, { recursive: true, force: true }); });

  it('removes shipped commands but keeps ones the user edited', async () => {
    const src = path.join(tmp, 'shipped'); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'recall.md'), 'shipped recall');
    fs.writeFileSync(path.join(src, 'remember.md'), 'shipped remember');
    const cmds = path.join(tmp, '.claude', 'commands'); fs.mkdirSync(cmds, { recursive: true });
    fs.writeFileSync(path.join(cmds, 'recall.md'), 'shipped recall');
    fs.writeFileSync(path.join(cmds, 'remember.md'), 'my own edited version');
    const { removeSlashCommands } = await import('../../src/cli/commands/uninstall.js');
    expect(await removeSlashCommands(src)).toBe(1);
    expect(fs.existsSync(path.join(cmds, 'recall.md'))).toBe(false);
    expect(fs.existsSync(path.join(cmds, 'remember.md'))).toBe(true);
  });
});
