import { describe, it, expect } from 'vitest';
import { useLocalSqlite } from '../helpers/sqlite.js';
import { validateFacts, quoteInWindow, extractWindows, type WindowContext } from '../../src/knowledge/extract.js';
import { redactSecrets, redactPII, containsSecret } from '../../src/knowledge/redact.js';
import { MockSynthesizer, extractJsonObject, repairJson, cleanSynthEnv, buildClaudeArgs, SynthError } from '../../src/knowledge/synth.js';
import { usefulRatio, isWorthExtracting, scopeForProject } from '../../src/knowledge/windows.js';
import * as factsDb from '../../src/store/db/facts.js';
import { EXTRACTOR_VERSION } from '../../src/knowledge/prompts.js';

const WINDOW = 'Alice: which profile do we use?\nClaude: Always use AWS_PROFILE=default for every aws command here.\nBrad: ok';

describe('quote grounding', () => {
  it('matches case/whitespace/quote-style insensitively, rejects short or absent quotes', () => {
    expect(quoteInWindow('always use  AWS_PROFILE=default for every aws command', WINDOW)).toBe(true);
    expect(quoteInWindow('ALWAYS USE AWS_PROFILE=DEFAULT', WINDOW)).toBe(true);
    expect(quoteInWindow('never use the work profile', WINDOW)).toBe(false);
    expect(quoteInWindow('short', WINDOW)).toBe(false);
  });
});

describe('validateFacts', () => {
  const good = { text: 'AWS CLI calls use profile default.', kind: 'convention', applies: 'global', entities: ['AWS CLI'], quote: 'Always use AWS_PROFILE=default for every aws command' };
  it('accepts a grounded fact and normalises fields', () => {
    const { facts, rejected } = validateFacts([good], WINDOW);
    expect(rejected).toEqual([]);
    expect(facts[0]).toMatchObject({ kind: 'convention', applies: 'global', entities: ['AWS CLI'] });
  });
  it('rejects ungrounded, bad-kind, empty, oversized and malformed facts with reasons', () => {
    const { facts, rejected } = validateFacts([
      { ...good, quote: 'this was never said in the window at all' },
      { ...good, kind: 'opinion' },
      { ...good, text: '' },
      { ...good, text: 'x'.repeat(600) },
      { ...good, quote: 'tiny' },
      'junk', null,
    ], WINDOW);
    expect(facts).toHaveLength(0);
    expect(rejected.map(r => r.reason)).toEqual([
      'quote-not-in-window', 'bad-kind', 'empty-text', 'too-long', 'bad-quote-length', 'not-object', 'not-object',
    ]);
  });
  it('non-array input yields nothing', () => {
    expect(validateFacts(undefined, WINDOW)).toEqual({ facts: [], rejected: [] });
  });
});

describe('redaction', () => {
  it('redacts credentials of many shapes but leaves ordinary text alone', () => {
    const dirty = [
      'key AKIAIOSFODNN7EXAMPLE', 'mailer re_zzTESTzz_0000000000AAAAAAAAAAbbbbbbbb', 'sk-ant-abcdefghijklmnopqrstu',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Authorization: Bearer abcdefghijklmnop1234567890',
      'postgresql://johnny:hunter2secret@relay.example.com:8443/johnny', 'password: correct-horse-battery', 'api_key = "abcd1234efgh5678"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const clean = redactSecrets(dirty);
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', 're_zzTESTzz', 'sk-ant-abcdef', 'ghp_abcdefg', 'abcdefghijklmnop1234567890', 'hunter2secret', 'correct-horse', 'abcd1234efgh5678', 'MIIEow']) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('postgresql://johnny:[REDACTED]@relay.example.com');
    const ok = 'The relay listens on port 8443 at relay.example.com and the password policy is documented.';
    expect(redactSecrets(ok)).toBe(ok);
    expect(containsSecret(dirty)).toBe(true);
    expect(containsSecret(ok)).toBe(false);
  });
  it('PII redaction adds emails, phones and IPs for external judges', () => {
    const r = redactPII('mail alice@example.com or call (408) 555-1234 from 10.0.0.12');
    expect(r).toBe('mail [EMAIL] or call [PHONE] from [IP]');
  });
});

describe('windows helpers', () => {
  it('flags tool-marker noise and tiny windows', () => {
    const noise = Array.from({ length: 30 }, (_, i) => `[tool: Read]\n[tool result: ok ${i}]`).join('\n');
    expect(usefulRatio(noise)).toBeLessThan(0.1);
    expect(isWorthExtracting(noise)).toBe(false);
    expect(isWorthExtracting('hi')).toBe(false);
    expect(isWorthExtracting('Alice: ' + 'we decided to keep the relay on the music box because it is cheap. '.repeat(6))).toBe(true);
  });
  it('scope is global for empty paths and stable for others', () => {
    expect(scopeForProject('')).toBe('global');
    expect(scopeForProject(null)).toBe('global');
    expect(scopeForProject('/tmp/definitely-not-a-repo/')).toBe('/tmp/definitely-not-a-repo');
  });
});

describe('synthesizer plumbing', () => {
  it('extracts the first balanced JSON object from chatty or fenced output', () => {
    expect(extractJsonObject('Sure! ```json\n{"a":{"b":[1,2]},"c":"}"}\n``` hope that helps')).toEqual({ a: { b: [1, 2] }, c: '}' });
    expect(extractJsonObject('prefix {"x":1} suffix {"y":2}')).toEqual({ x: 1 });
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{broken')).toBeNull();
  });
  it('repairs the almost-valid JSON models sometimes emit (stray closer, trailing comma, truncation)', () => {
    // the real failure seen live: an extra "}" after the first fact
    const stray = '{"windows":[{"id":"W1","facts":[{"text":"a","quote":"b"}},{"text":"c","quote":"d"}]}]}';
    expect((extractJsonObject(stray) as any).windows[0].facts).toHaveLength(2);
    expect(extractJsonObject('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
    expect(extractJsonObject('{"windows":[{"id":"W1","facts":[{"text":"cut off mid')).toEqual({ windows: [{ id: 'W1', facts: [{ text: 'cut off mid' }] }] });
    expect(JSON.parse(repairJson('{"x":"} not a closer"}'))).toEqual({ x: '} not a closer' }); // braces inside strings untouched
    expect(extractJsonObject('totally not json')).toBeNull();
  });

  it('the Claude CLI call is tool-less, restricted, MCP-less, non-persistent and runs with a clean env', () => {
    const args = buildClaudeArgs('sonnet', 'sys');
    expect(args).toEqual(expect.arrayContaining(['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--model', 'sonnet']));
    expect(args[args.indexOf('--tools') + 1]).toBe(''); // all tools disabled
    const env = cleanSynthEnv({ HOME: '/h', PATH: '/p', CLAUDE_CODE_SESSION_ID: 'leak', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', SECRET: 's' } as NodeJS.ProcessEnv);
    expect(env).toEqual({ HOME: '/h', PATH: '/p', JOHNNY_BYPASS: '1' });
  });
  it('MockSynthesizer errors loudly when a script runs out', async () => {
    const m = new MockSynthesizer(['one']);
    await m.complete({ role: 'extract', prompt: 'p' });
    await expect(m.complete({ role: 'extract', prompt: 'p' })).rejects.toBeInstanceOf(SynthError);
  });
});

describe('extractWindows (local SQLite)', () => {
  useLocalSqlite();
  const ctx = (hash: string): WindowContext => ({
    hash, memoryId: 'mem-1', chunkIds: ['c#0'], text: WINDOW, scope: '/tmp/p', sessionId: 'sess-1',
    mentionedAt: '2026-10-01T00:00:00.000Z', title: 'AWS session',
  });
  const reply = (quote = 'Always use AWS_PROFILE=default for every aws command') => JSON.stringify({ windows: [{
    id: 'W1', facts: [{ text: 'AWS CLI calls use profile default.', kind: 'convention', when: '', applies: 'global', entities: ['AWS CLI'], quote }],
  }] });

  it('stores grounded facts, is idempotent per window hash, dedupes exact text, and redacts secrets', async () => {
    const synth = new MockSynthesizer(() => reply());
    const s1 = await extractWindows(synth, [ctx('h1')], { embedFacts: false });
    expect(s1).toMatchObject({ windowsSent: 1, factsAccepted: 1, factsRejected: 0 });
    expect(s1.created[0].windowText).toContain('AWS_PROFILE');
    const f = (await factsDb.listActiveFacts('global'))[0];
    expect(f).toMatchObject({ scope: 'global', kind: 'convention', session_id: 'sess-1', extractor_version: EXTRACTOR_VERSION });

    const s2 = await extractWindows(synth, [ctx('h1')], { embedFacts: false }); // same hash: skipped, no model call
    expect(s2.windowsSkippedDone).toBe(1);
    expect((synth as MockSynthesizer).calls).toHaveLength(1);

    const s3 = await extractWindows(synth, [ctx('h2')], { embedFacts: false }); // new window, same fact text: exact-duplicate guard
    expect(s3.factsAccepted).toBe(0);
    expect(await factsDb.countFacts()).toBe(1);
  });

  it('rejects ungrounded facts with reasons', async () => {
    const bad = new MockSynthesizer(() => reply('a quote that does not exist in the window'));
    const s = await extractWindows(bad, [ctx('h3')], { embedFacts: false });
    expect(s.factsAccepted).toBe(0);
    expect(s.rejectReasons['quote-not-in-window']).toBe(1);
  });

  it('isolates a poison window: a failed group is retried one window at a time', async () => {
    // First call (group of two) is garbage; the single-window retries succeed for w-good and fail for w-bad.
    let n = 0;
    const synth = new MockSynthesizer((req) => {
      n++;
      if (req.prompt.includes('WINDOW W2')) return 'I am sorry, I cannot do that.'; // group call: unusable
      return req.prompt.includes('POISON') ? 'still not json' : reply();
    });
    const good = { ...ctx('good') };
    const bad = { ...ctx('bad'), text: WINDOW + '\nPOISON' };
    const s = await extractWindows(synth, [good, bad], { embedFacts: false });
    expect(n).toBe(4);                              // 1 group call + good + bad + one immediate retry of bad
    expect(s.windowsFailed).toBe(1);
    expect(s.factsAccepted).toBe(1);                // the good window still made it through
    expect((await factsDb.getExtractionLog('good', EXTRACTOR_VERSION))!.status).toBe('done');
    const log = (await factsDb.getExtractionLog('bad', EXTRACTOR_VERSION))!;
    expect(log).toMatchObject({ status: 'failed', attempts: 1, last_error: 'unparseable model output' });
  });

  it('abandons a window after 3 failed attempts so it cannot stall the backfill', async () => {
    const junk = new MockSynthesizer(() => 'nope');
    for (let i = 0; i < 3; i++) await extractWindows(junk, [ctx('stuck')], { embedFacts: false });
    expect((await factsDb.getExtractionLog('stuck', EXTRACTOR_VERSION))).toMatchObject({ status: 'failed', attempts: 3 });
    const before = junk.calls.length;
    const s = await extractWindows(junk, [ctx('stuck')], { embedFacts: false }); // 4th time: given up, NO model call
    expect(s.windowsGaveUp).toBe(1);
    expect(junk.calls.length).toBe(before);
    expect((await factsDb.getExtractionLog('stuck', EXTRACTOR_VERSION))!.status).toBe('skipped');
  });

  it('a window the model silently omits counts as a failed attempt (bounded retries)', async () => {
    const silent = new MockSynthesizer(() => JSON.stringify({ windows: [] }));
    const s = await extractWindows(silent, [ctx('h4')], { embedFacts: false });
    expect(s.windowsFailed).toBe(1);
    expect((await factsDb.getExtractionLog('h4', EXTRACTOR_VERSION))).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('never persists a secret that appears in a fact', async () => {
    const win = { ...ctx('h6'), text: 'Alice: the key is AKIAIOSFODNN7EXAMPLE for the deploy user in the account we use daily for everything.\nClaude: noted, the deploy key is AKIAIOSFODNN7EXAMPLE now.' };
    const synth = new MockSynthesizer(() => JSON.stringify({ windows: [{ id: 'W1', facts: [{
      text: 'The deploy key is AKIAIOSFODNN7EXAMPLE.', kind: 'state', applies: 'project', entities: [],
      quote: 'the deploy key is [REDACTED_AWS_KEY] now' }] }] }));
    await extractWindows(synth, [win], { embedFacts: false });
    const all = await factsDb.listActiveFacts('/tmp/p');
    for (const f of all) {
      expect(f.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(f.source_quote ?? '').not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  });
});
