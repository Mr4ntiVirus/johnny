import { describe, it, expect } from 'vitest';
import { splitSections, sectionTitle } from '../../src/knowledge/sections.js';

describe('splitSections', () => {
  it('splits on level-2 headings, keeping the intro as its own part', () => {
    const doc = 'Intro line.\n\n## One\nalpha\n\n## Two\nbeta\ngamma';
    expect(splitSections(doc)).toEqual(['Intro line.', '## One\nalpha', '## Two\nbeta\ngamma']);
  });
  it('a document without headings is a single section; empty is none', () => {
    expect(splitSections('just prose')).toEqual(['just prose']);
    expect(splitSections('  \n ')).toEqual([]);
  });
  it('does not split on ### subsections', () => {
    expect(splitSections('## A\nx\n### sub\ny')).toHaveLength(1);
  });
  it('sectionTitle returns the heading text', () => {
    expect(sectionTitle('## Network\nbody')).toBe('Network');
    expect(sectionTitle('no heading')).toBe('');
  });
});

import { MODEL_SYSTEM } from '../../src/knowledge/prompts.js';
describe('model prompt guards', () => {
  it('tells the writer to stay on subject and not write a status log', () => {
    expect(MODEL_SYSTEM).toMatch(/STAY ON SUBJECT/);
    expect(MODEL_SYSTEM).toMatch(/status or open-issues log/);
  });
});

import { dropUnsupportedLines } from '../../src/knowledge/refresh.js';
describe('dropUnsupportedLines', () => {
  const doc = '## Shell\n- Alice uses zsh as the login shell on the Mac.\n- The default AWS profile is default.\n\n## Editor\n- The preferred editor is vim.';
  it('drops only the lines carrying rejected claims and keeps headings', () => {
    const out = dropUnsupportedLines(doc, ['Alice uses zsh as the login shell', 'The preferred editor is vim']);
    expect(out).toContain('## Shell');
    expect(out).toContain('## Editor');
    expect(out).toContain('default AWS profile');
    expect(out).not.toContain('zsh');
    expect(out).not.toContain('vim');
  });
  it('returns null when no line matches, so nothing is re-verified for no reason', () => {
    expect(dropUnsupportedLines(doc, ['completely unrelated statement about kubernetes clusters'])).toBeNull();
    expect(dropUnsupportedLines(doc, [])).toBeNull();
  });
});
