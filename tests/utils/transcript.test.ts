import { describe, it, expect } from 'vitest';
import { looksLikeQuestion, looksLikeAnswer, toStagePlayFormat } from '../../src/utils/transcript.js';

// Build a JSONL line from a Claude Code message shape. Shapes mirror what
// lands in ~/.claude/projects/**/*.jsonl on disk.
function jsonl(...messages: Array<{ type: 'user' | 'assistant'; content: unknown }>): string {
  return messages
    .map(m => JSON.stringify({ type: m.type, message: { role: m.type, content: m.content } }))
    .join('\n');
}

describe('looksLikeQuestion', () => {
  it('returns false for null', () => {
    expect(looksLikeQuestion(null)).toBe(false);
  });

  it('returns false for statements', () => {
    expect(looksLikeQuestion('All 83 tests pass.')).toBe(false);
    expect(looksLikeQuestion('Done. Build is clean.')).toBe(false);
  });

  it('detects trailing question mark', () => {
    expect(looksLikeQuestion('Which one do you want?')).toBe(true);
    expect(looksLikeQuestion('Great work.\n\nReady to ship?')).toBe(true);
  });

  it('detects numbered-list questions', () => {
    const msg = 'Pick one:\n1. foo\n2. bar\n3. baz';
    expect(looksLikeQuestion(msg)).toBe(true);
  });

  it('detects question starters with supporting "?"', () => {
    expect(looksLikeQuestion('Which approach feels right?')).toBe(true);
  });

  it('does not fire on prose containing "which"', () => {
    expect(looksLikeQuestion('The file which contains the config is here.')).toBe(false);
  });
});

describe('looksLikeAnswer', () => {
  it('treats tiny prompts as answers', () => {
    expect(looksLikeAnswer('1')).toBe(true);
    expect(looksLikeAnswer('yes')).toBe(true);
    expect(looksLikeAnswer('the first one')).toBe(true);
  });

  it('rejects medium prompts without answer shape', () => {
    // 40 chars, no answer shape — previously would've been treated as an answer.
    expect(looksLikeAnswer('fix the bug in auth.ts please right now')).toBe(false);
  });

  it('detects confirmation starters in longer prompts', () => {
    const long = 'yes, absolutely, and I also want to make sure we handle the edge case where the user types something weird in the picker and it fails gracefully with an error message';
    expect(looksLikeAnswer(long)).toBe(true);
  });

  it('detects negation starters', () => {
    expect(looksLikeAnswer("no, don't do that")).toBe(true);
    expect(looksLikeAnswer('nope')).toBe(true);
  });

  it('detects option/number picks', () => {
    expect(looksLikeAnswer('option 2')).toBe(true);
    expect(looksLikeAnswer('2')).toBe(true);
  });

  it('rejects long prompts without answer shape', () => {
    const long = 'Now let me completely change the subject and talk about something else entirely, like how we should redesign the daemon to use a different IPC mechanism because the current approach has issues I want to dig into deeply';
    expect(looksLikeAnswer(long)).toBe(false);
  });
});

describe('toStagePlayFormat — signal-to-noise', () => {
  const opts = { userName: 'alice', assistantName: 'Claude' };

  it('renders plain user prompts as a single labeled line', () => {
    const out = toStagePlayFormat(jsonl({ type: 'user', content: 'fix the auth bug' }), opts);
    expect(out).toBe('alice: fix the auth bug');
  });

  it('strips tool_use_id / type / is_error from user-role tool_result blocks', () => {
    const block = [{
      tool_use_id: 'toolu_01Hncv99ZcziHaEpGNjDH9sW',
      type: 'tool_result',
      content: '(Bash completed with no output)',
      is_error: false,
    }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out).not.toContain('tool_use_id');
    expect(out).not.toContain('toolu_');
    expect(out).not.toContain('is_error');
    expect(out).toBe('[tool result: (Bash completed with no output)]');
  });

  it('drops trimmed-stub tool results entirely (zero signal)', () => {
    const block = [{
      tool_use_id: 'toolu_xyz',
      type: 'tool_result',
      content: '[Trimmed tool result: ~4955 chars]',
      is_error: false,
    }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out).toBe('');
  });

  it('drops trimmed-stub when content is wrapped in a text block', () => {
    const block = [{
      tool_use_id: 'toolu_xyz',
      type: 'tool_result',
      content: [{ type: 'text', text: '[Trimmed tool result: ~7607 chars]' }],
    }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out).toBe('');
  });

  it('truncates long tool results to a head + ellipsis', () => {
    const long = 'x'.repeat(500);
    const block = [{ tool_use_id: 't', type: 'tool_result', content: long }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out.startsWith('[tool result: ')).toBe(true);
    expect(out.endsWith('…]')).toBe(true);
    // 200-char head — the body of the brackets sits comfortably under 250.
    expect(out.length).toBeLessThan(250);
  });

  it('renders assistant tool_use blocks as [tool: name] markers', () => {
    const out = toStagePlayFormat(jsonl({
      type: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', name: 'Read', input: { path: '/x' } },
      ],
    }), opts);
    expect(out).toContain('Claude: Reading the file.');
    expect(out).toContain('[tool: Read]');
  });

  it('handles a realistic mixed transcript without bleeding JSON', () => {
    const transcript = jsonl(
      { type: 'user', content: 'check the build' },
      { type: 'assistant', content: [
        { type: 'text', text: 'Running the build.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } },
      ]},
      { type: 'user', content: [{
        tool_use_id: 'toolu_01TgJq65fM4dov61pjvkyR6k',
        type: 'tool_result',
        content: 'build succeeded\n  3 files compiled',
      }]},
      { type: 'assistant', content: [{ type: 'text', text: 'Build is clean.' }] },
    );
    const out = toStagePlayFormat(transcript, opts);
    expect(out).not.toContain('tool_use_id');
    expect(out).not.toContain('toolu_');
    expect(out).not.toContain('"type"');
    expect(out).toContain('alice: check the build');
    expect(out).toContain('Claude: Running the build.');
    expect(out).toContain('[tool: Bash]');
    expect(out).toContain('[tool result: build succeeded');
    expect(out).toContain('Claude: Build is clean.');
  });

  it('returns input untouched when already stage-play formatted', () => {
    const already = 'alice: hello\nClaude: hi';
    expect(toStagePlayFormat(already, opts)).toBe(already);
  });

  it('skips empty/whitespace-only string content', () => {
    const out = toStagePlayFormat(jsonl({ type: 'user', content: '   ' }), opts);
    expect(out).toBe('');
  });

  // ── pass 2: deeper noise reduction ────────────────────────────────────────

  it('drops edit-success boilerplate tool results entirely', () => {
    const block = [{
      tool_use_id: 't',
      type: 'tool_result',
      content: 'The file /home/alice/dev/johnny/src/x.ts has been updated successfully. (file state is current in your context — no need to Read it back)',
    }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out).toBe('');
  });

  it('strips Read-tool line-number prefixes (\\d+\\t and \\d+:)', () => {
    const codeWithLineNums = '2\timport * as path from "node:path";\n141:export type Action =\n100\t\n3\timport { fs } from "node:fs";';
    const block = [{ tool_use_id: 't', type: 'tool_result', content: codeWithLineNums }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    // Numeric prefix gone, content preserved
    expect(out).toContain('import * as path from "node:path";');
    expect(out).toContain('export type Action =');
    expect(out).toContain('import { fs } from "node:fs";');
    // Bare `100\t` (line number with no content) dropped
    expect(out).not.toMatch(/^\s*100/m);
    // Original prefix `2\t` and `141:` removed
    expect(out).not.toMatch(/^2\t/m);
    expect(out).not.toMatch(/^141:/m);
  });

  it('strips local-command-caveat XML scaffolding', () => {
    const text = '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>actually, fix the auth bug';
    const out = toStagePlayFormat(jsonl({ type: 'user', content: text }), opts);
    expect(out).not.toContain('local-command-caveat');
    expect(out).not.toContain('DO NOT respond');
    expect(out).toContain('actually, fix the auth bug');
  });

  it('strips persisted-output framing wrappers', () => {
    const inner = 'Output too large (72.6KB). Full output saved to: /home/alice/.claude/projects/x/tool-results/y.txt';
    const block = [{
      tool_use_id: 't',
      type: 'tool_result',
      content: `<persisted-output>\n${inner}\n</persisted-output>`,
    }];
    const out = toStagePlayFormat(jsonl({ type: 'user', content: block }), opts);
    expect(out).not.toContain('<persisted-output>');
    expect(out).not.toContain('</persisted-output>');
  });

  it('drops RTF-format escape sequences (e.g. paste from rich-text source)', () => {
    const text = 'fix the bug\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\nplease';
    const out = toStagePlayFormat(jsonl({ type: 'user', content: text }), opts);
    expect(out).not.toContain('cocoatextscaling');
    expect(out).not.toContain('fonttbl');
    expect(out).toContain('fix the bug');
    expect(out).toContain('please');
  });

  it('re-attributes compaction-continuation summary as [continuation summary]', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\nKey decision: use SQLite WAL mode for concurrency.';
    const out = toStagePlayFormat(jsonl({ type: 'user', content: summary }), opts);
    expect(out).toContain('[continuation summary]');
    expect(out).not.toMatch(/^alice: This session is being continued/);
    // Body preserved — retrieval should still find this content
    expect(out).toContain('SQLite WAL mode');
  });

  it('silently drops assistant thinking blocks', () => {
    const out = toStagePlayFormat(jsonl({
      type: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me consider whether this is the right approach...' },
        { type: 'text', text: "Here's the answer." },
      ],
    }), opts);
    expect(out).not.toContain('Let me consider');
    expect(out).not.toContain('thinking');
    expect(out).toBe('Claude: Here\'s the answer.');
  });
});
