import { describe, it, expect } from 'vitest';
import {
  extractBashCalls, fireKey, isSensitiveCall, looksSensitive, queryFor, replayCalls, stratifiedSample, type BashCall,
} from '../../src/cli/commands/eval-prime-tool.js';
import { judgeToolPrime, labelKey, toolLabelsPath } from '../../src/knowledge/prime-labels.js';
import type { Synthesizer, SynthRequest } from '../../src/knowledge/synth.js';

const rec = (o: object) => JSON.stringify(o);
const ts = (s: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, s)).toISOString();

function transcript(): string {
  return [
    rec({ type: 'user', timestamp: ts(0), cwd: '/w', message: { content: 'Please deploy the relay and check connectivity' } }),
    rec({ type: 'assistant', timestamp: ts(5), cwd: '/w', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'aws s3 ls s3://bucket/prefix --profile default' } }] } }),
    rec({ type: 'user', timestamp: ts(6), cwd: '/w', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\nAn error occurred (AccessDenied)', is_error: true }] } }),
    rec({ type: 'assistant', timestamp: ts(10), cwd: '/w', message: { content: [
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/x' } },
    ] } }),
    rec({ type: 'user', timestamp: ts(11), cwd: '/w', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok output' }] }] } }),
    rec({ type: 'system', subtype: 'compact_boundary', timestamp: ts(20) }),
    rec({ type: 'assistant', timestamp: ts(30), cwd: '/w', isSidechain: true, message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'sidechain command here' } }] } }),
    rec({ type: 'user', timestamp: ts(40), cwd: '/w', message: { content: '<task-notification>background done</task-notification>' } }),
    rec({ type: 'assistant', timestamp: ts(50), cwd: '/w', message: { content: [{ type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'docker compose up -d relay' } }] } }),
    'not json',
  ].join('\n');
}

describe('extractBashCalls', () => {
  const { calls, sidechain } = extractBashCalls(transcript(), 's1');

  it('keeps only main-thread Bash calls, counts subagent ones, and tolerates junk lines', () => {
    expect(calls.map(c => c.command)).toEqual(['aws s3 ls s3://bucket/prefix --profile default', 'ls -la', 'docker compose up -d relay']);
    expect(sidechain).toBe(1);
  });

  it('pairs each call with its result, string or text-block content, and the failure flag', () => {
    expect(calls[0].failed).toBe(true);
    expect(calls[0].resultText).toMatch(/AccessDenied/);
    expect(calls[1].failed).toBe(false);
    expect(calls[1].resultText).toBe('ok output');
  });

  it('attaches the nearest genuine user request (notifications are not requests) and counts compaction epochs', () => {
    expect(calls.map(c => c.request)).toEqual(Array(3).fill('Please deploy the relay and check connectivity'));
    expect(calls.map(c => c.epoch)).toEqual([0, 0, 1]);
    expect(calls[0].atMs).toBe(Date.parse(ts(5)));
  });
});

describe('queryFor', () => {
  const { calls } = extractBashCalls(transcript(), 's1');
  it('command mode uses the command; error and both modes consider failed calls only', () => {
    expect(queryFor(calls[0], 'command')).toBe(calls[0].command);
    expect(queryFor(calls[1], 'error')).toBeNull();
    expect(queryFor(calls[0], 'error')).toMatch(/AccessDenied/);
    expect(queryFor(calls[0], 'both')).toMatch(/^aws s3 ls[\s\S]*AccessDenied/);
  });
});

describe('replayCalls applies the production rules', () => {
  const { calls } = extractBashCalls(transcript(), 's1');
  const seen: Array<{ command: string; surfaced: string[]; turn: number }> = [];
  const decide = async (c: BashCall, _q: string, surfaced: Record<string, number>, turn: number) => {
    seen.push({ command: c.command, surfaced: Object.keys(surfaced), turn });
    return { refs: ['model:a'], topScore: 0.6, digest: 'd' };
  };

  it('drops trivial commands, then throttles to one scan per minute per session', async () => {
    seen.length = 0;
    const st = await replayCalls(calls, 'command', 60_000, decide);
    expect(st).toMatchObject({ bash: 3, eligible: 3, trivial: 1, throttled: 1, scans: 1 });
    expect(st.fires).toHaveLength(1);
  });

  it('a new context epoch starts with an empty surfaced map; the same epoch does not', async () => {
    seen.length = 0;
    await replayCalls(calls, 'command', 0, decide);
    expect(seen.map(s => s.surfaced)).toEqual([[], []]);                 // calls 0 and 2 are in epochs 0 and 1
    seen.length = 0;
    const sameEpoch = [calls[0], { ...calls[2], epoch: 0, atMs: calls[0].atMs + 90_000 }];
    await replayCalls(sameEpoch, 'command', 0, decide);
    expect(seen[1].surfaced).toEqual(['model:a']);                       // what the first fire primed is held back
  });

  it('error mode only considers failed calls', async () => {
    const st = await replayCalls(calls, 'error', 0, decide);
    expect(st.eligible).toBe(1);
    expect(st.bash).toBe(3);
  });

  it('keeps sessions independent', async () => {
    seen.length = 0;
    const other = { ...calls[0], session: 's2' };
    await replayCalls([calls[0], other], 'command', 60_000, decide);
    expect(seen).toHaveLength(2);                                        // the throttle is per session
    expect(seen[1].surfaced).toEqual([]);
  });
});

describe('sensitivity: evaluated locally, never sent to the judge', () => {
  it('flags env-style secrets that redactSecrets alone misses, plus bearer tokens, URL credentials and API keys', () => {
    for (const bad of [
      'PGPASSWORD=hunter2hunter2 psql -h db -U app',
      'export AWS_SECRET_ACCESS_KEY=abc/defghijkl && aws s3 ls',
      'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://x',
      'psql postgres://u:p4ssw0rd@h/db',
      'MAILER_API_KEY=re_abcdefghijklmnop12345678 node x.js',
    ]) expect(looksSensitive(bad), bad).toBe(true);
  });

  it('leaves ordinary commands alone', () => {
    for (const ok of ['aws s3 ls s3://bucket --profile default', 'docker compose up -d relay', 'grep -rn password_policy src/', 'ssh -i ~/dev/k.pem ubuntu@host']) {
      expect(looksSensitive(ok), ok).toBe(false);
    }
  });

  it('checks the command, the result and the request', () => {
    const base: BashCall = { session: 's', cwd: '/', atMs: 0, command: 'ls /tmp/example', failed: false, resultText: '', request: '', epoch: 0 };
    expect(isSensitiveCall(base)).toBe(false);
    expect(isSensitiveCall({ ...base, resultText: 'DB_PASSWORD=swordfish123' })).toBe(true);
    expect(isSensitiveCall({ ...base, request: `my token: ${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}` })).toBe(true);
  });
});

describe('fireKey', () => {
  it('keys on the text that triggered the prime, so a failure-text fire never reuses a command verdict', () => {
    const { calls } = extractBashCalls(transcript(), 's1');
    const decision = { refs: ['model:a'], topScore: 0.7, digest: 'd' };
    const byCommand = { call: calls[0], query: queryFor(calls[0], 'command')!, decision };
    const byError = { call: calls[0], query: queryFor(calls[0], 'error')!, decision };
    expect(fireKey(byCommand)).not.toBe(fireKey(byError));
    expect(fireKey(byCommand)).toBe(labelKey(calls[0].command, ['model:a']));   // command mode keeps the original keys, so existing labels stay valid
  });
});

describe('stratifiedSample', () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ key: `a${i}`, score: 0.55 })),
    ...Array.from({ length: 3 }, (_, i) => ({ key: `b${i}`, score: 0.64 })),
    { key: 'c0', score: 0.7 },
  ];
  const edges = [0.53, 0.58, 0.63, 0.68];

  it('draws round-robin across bands, so rare high-similarity fires are not crowded out', () => {
    const picked = stratifiedSample(items, edges, 5).map(i => i.key);
    expect(picked).toEqual(['a0', 'b0', 'c0', 'a1', 'b1']);
  });

  it('is deterministic and never exceeds the budget or the pool', () => {
    expect(stratifiedSample(items, edges, 5)).toEqual(stratifiedSample([...items].reverse(), edges, 5));
    expect(stratifiedSample(items, edges, 100)).toHaveLength(items.length);
    expect(stratifiedSample(items, edges, 0)).toEqual([]);
  });
});

describe('judgeToolPrime', () => {
  const fake = (reply: string): Synthesizer & { last?: SynthRequest } => {
    const s: Synthesizer & { last?: SynthRequest } = {
      name: 'fake',
      async complete(req) { s.last = req; return { text: reply, inputTokens: 1, outputTokens: 1 }; },
    };
    return s;
  };
  const ctx = { request: 'fix the deploy', command: 'aws s3 ls', result: 'AccessDenied', failed: true };

  it('shows the judge the request, command, result and digest as data, and parses the verdict', async () => {
    const synth = fake('{"verdict":"helpful","reason":"names the profile"}');
    const label = await judgeToolPrime(synth, ctx, 'Use AWS_PROFILE=default');
    expect(label).toEqual({ verdict: 'helpful', reason: 'names the profile' });
    const p = synth.last!.prompt;
    expect(p).toContain('fix the deploy');
    expect(p).toContain('aws s3 ls');
    expect(p).toContain('the command FAILED');
    expect(p).toContain('Use AWS_PROFILE=default');
    expect(synth.last!.system).toMatch(/NEXT step/);
  });

  it('does not mark a successful command as failed, and returns null for an unparseable reply', async () => {
    const synth = fake('not json');
    expect(await judgeToolPrime(synth, { ...ctx, failed: false }, 'd')).toBeNull();
    expect(synth.last!.prompt).not.toContain('FAILED');
  });

  it('keeps tool labels in their own fixture', () => {
    expect(toolLabelsPath()).toMatch(/tool-prime-labels\.json$/);
  });
});
