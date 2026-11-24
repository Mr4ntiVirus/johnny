import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('automatic synthesis consent', () => {
  let tmp: string; let oldHome: string | undefined;
  beforeEach(() => { oldHome = process.env.HOME; tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-auto-')); process.env.HOME = tmp; });
  afterEach(() => { process.env.HOME = oldHome; fs.rmSync(tmp, { recursive: true, force: true }); });

  it('setAutoSynth stores the choice without clobbering other config', async () => {
    fs.mkdirSync(path.join(tmp, '.johnny'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.johnny', 'config.json'), JSON.stringify({ topKOutgoing: 7, knowledge: { prime: false } }));
    const { setAutoSynth } = await import('../../src/knowledge/heartbeat.js');
    await setAutoSynth(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.johnny', 'config.json'), 'utf-8'));
    expect(cfg.topKOutgoing).toBe(7);
    expect(cfg.knowledge).toEqual({ prime: false, autoSynth: true });
    await setAutoSynth(false);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, '.johnny', 'config.json'), 'utf-8')).knowledge.autoSynth).toBe(false);
  });

  it('priming is on by default and autoSynth is undecided until the user answers', async () => {
    const { DEFAULT_KNOWLEDGE_CONFIG } = await import('../../src/knowledge/config.js');
    expect(DEFAULT_KNOWLEDGE_CONFIG.prime).toBe(true);
    expect(DEFAULT_KNOWLEDGE_CONFIG.autoSynth).toBeUndefined();
  });
});
