import { describe, it, expect } from 'vitest';
import { mustHavePhrases, coverageOf } from '../../src/cli/commands/eval-knowledge.js';

describe('eval-knowledge helpers', () => {
  const note = `---
name: x
---
The build server lives at \`build.example.com:8443\` (see \`project_notes.md\`), fixed 2026-06-13.
Use \`JOHNNY_MODE=local\`. Also media.example.com runs a media server.`;
  it('derives must-have phrases from backticks, dates and hostnames, ignoring frontmatter', () => {
    const p = mustHavePhrases(note);
    expect(p).toEqual(expect.arrayContaining(['build.example.com:8443', 'JOHNNY_MODE=local', '2026-06-13', 'media.example.com']));
    expect(p).not.toContain('name: x');
  });
  it('measures coverage case-insensitively and lists what is missing', () => {
    const { hit, missing } = coverageOf(['JOHNNY_MODE=local', '2026-06-13', 'media.example.com'],
      'the default is johnny_mode=local as of 2026-06-13'.toLowerCase());
    expect(hit).toEqual(['JOHNNY_MODE=local', '2026-06-13']);
    expect(missing).toEqual(['media.example.com']);
  });
});
