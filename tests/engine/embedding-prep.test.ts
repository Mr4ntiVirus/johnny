import { describe, it, expect } from 'vitest';
import { cleanForEmbedding } from '../../src/engine/chunker.js';

describe('cleanForEmbedding', () => {
  it('collapses long tracking URLs to host + first path segment', () => {
    const t = 'see https://www.indeed.com/rc/clk/dl?jk=b45304994703009d&from=ja&qd=RnZhMybXSk4M3QtTVGXWoTWM9SYXna59HVtN2NJRjOhWb and (https://example.org/docs/page?a=1#x) ok';
    const c = cleanForEmbedding(t);
    expect(c).toContain('www.indeed.com/rc');
    expect(c).toContain('example.org/docs');
    expect(c).not.toContain('jk=');
    expect(c.length).toBeLessThan(t.length / 2);
  });
  it('replaces opaque 40+ char tokens but leaves ordinary words, numbers and paths alone', () => {
    const t = 'token abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ end; port 8443 at relay.example.com in /home/alice/dev';
    const c = cleanForEmbedding(t);
    expect(c).toContain('…');
    expect(c).toContain('port 8443 at relay.example.com');
    expect(c).toContain('/home/alice/dev');
    expect(c).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
  it('is the identity for plain prose', () => {
    const t = 'We decided to keep the relay on the music box because it is cheap.';
    expect(cleanForEmbedding(t)).toBe(t);
  });
});
