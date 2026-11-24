// Pure tests for the content-addressed snapshot delta (no DB needed).
// These pin the regressions behind the "83% duplicate chunks" finding:
//   (a) trim zeroed the line cursor -> whole post-trim file re-captured
//   (b) resumed sessions copy history (same uuids) into a new session file
//   (c) cursor past EOF must not stall snapshots forever
import { describe, it, expect } from 'vitest';
import { computeDelta, parseJsonlLines } from '../../src/actions/snapshot-delta.js';

const msg = (uuid: string, type: 'user' | 'assistant' = 'user') =>
  JSON.stringify({ type, uuid, message: { role: type, content: `content of ${uuid}` } });
const meta = (type: string) => JSON.stringify({ type, value: 'x' }); // no uuid (mode, ai-title, ...)

const ledgerOf = (...uuids: string[]) => async (query: string[]) =>
  new Set(query.filter(u => uuids.includes(u)));

describe('computeDelta', () => {
  it('fresh session, no anchor: everything is new', async () => {
    const lines = [msg('a'), msg('b', 'assistant'), msg('c')];
    const d = await computeDelta(lines, { anchorUuid: null, legacyLineCursor: 0, lookupLedger: ledgerOf() });
    expect(d.deltaLines).toEqual(lines);
    expect(d.newUuids).toEqual(['a', 'b', 'c']);
    expect(d.lastUuid).toBe('c');
    expect(d.hasMessages).toBe(true);
    expect(d.anchorFound).toBe(false);
  });

  it('anchor present: only lines after it', async () => {
    const lines = [msg('a'), msg('b'), msg('c'), msg('d')];
    const d = await computeDelta(lines, { anchorUuid: 'b', legacyLineCursor: 2, lookupLedger: ledgerOf('a', 'b') });
    expect(d.newUuids).toEqual(['c', 'd']);
    expect(d.anchorFound).toBe(true);
  });

  it('regression (a): after a trim the anchor is still found and nothing is re-captured', async () => {
    // Old behaviour: trim zeroed the cursor => snapshot sliced from line 0 of the trimmed file.
    const trimmedFile = [msg('b'), msg('c'), msg('d'), msg('e')]; // 'a' was trimmed away
    const d = await computeDelta(trimmedFile, {
      anchorUuid: 'd', legacyLineCursor: 0, lookupLedger: ledgerOf('a', 'b', 'c', 'd'),
    });
    expect(d.newUuids).toEqual(['e']);
  });

  it('anchor trimmed away: the global ledger still prevents re-capture', async () => {
    const trimmedFile = [msg('c'), msg('d'), msg('e'), msg('f')];
    const d = await computeDelta(trimmedFile, {
      anchorUuid: 'b', // gone from the file
      legacyLineCursor: 0,
      lookupLedger: ledgerOf('a', 'b', 'c', 'd'),
    });
    expect(d.newUuids).toEqual(['e', 'f']);
    expect(d.anchorFound).toBe(false);
    expect(d.alreadySeen).toBe(2);
  });

  it('regression (b): resumed session copy under a new session id only yields the new tail', async () => {
    // New session file = full copy of old history (same uuids) + fresh messages, cursor 0, no anchor.
    const resumed = [msg('a'), msg('b'), msg('c'), msg('d'), msg('n1'), msg('n2', 'assistant')];
    const d = await computeDelta(resumed, {
      anchorUuid: null, legacyLineCursor: 0, lookupLedger: ledgerOf('a', 'b', 'c', 'd'),
    });
    expect(d.newUuids).toEqual(['n1', 'n2']);
    expect(d.deltaLines).toEqual([resumed[4], resumed[5]]);
  });

  it('regression (c): a legacy cursor past EOF is ignored and does not stall', async () => {
    const lines = [msg('a'), msg('b'), msg('c')];
    const d = await computeDelta(lines, { anchorUuid: null, legacyLineCursor: 2000, lookupLedger: ledgerOf() });
    expect(d.newUuids).toEqual(['a', 'b', 'c']); // not skipped
    expect(d.hasMessages).toBe(true);
  });

  it('pre-upgrade session with a valid legacy cursor honours it once', async () => {
    const lines = [msg('a'), msg('b'), msg('c'), msg('d')];
    const d = await computeDelta(lines, { anchorUuid: null, legacyLineCursor: 2, lookupLedger: ledgerOf() });
    expect(d.newUuids).toEqual(['c', 'd']);
  });

  it('only bookkeeping lines new: hasMessages is false (no memory should be minted)', async () => {
    const lines = [msg('a'), msg('b'), meta('mode'), meta('ai-title'), meta('last-prompt')];
    const d = await computeDelta(lines, { anchorUuid: 'b', legacyLineCursor: 0, lookupLedger: ledgerOf('a', 'b') });
    expect(d.hasMessages).toBe(false);
    expect(d.lastUuid).toBe('b');
  });

  it('uuid-less lines older than an already-captured line are dropped, newer ones kept', async () => {
    const lines = [meta('mode'), msg('a'), meta('ai-title'), msg('b'), meta('last-prompt'), msg('c')];
    const d = await computeDelta(lines, { anchorUuid: null, legacyLineCursor: 0, lookupLedger: ledgerOf('a', 'b') });
    // 'mode' (before a) and 'ai-title' (before b) dropped; 'last-prompt' (after b) kept with 'c'.
    expect(d.deltaLines).toEqual([lines[4], lines[5]]);
    expect(d.newUuids).toEqual(['c']);
  });

  it('unparseable lines are treated as uuid-less, not fatal', () => {
    const p = parseJsonlLines(['{not json', msg('a')]);
    expect(p[0]).toMatchObject({ uuid: null, type: null });
    expect(p[1].uuid).toBe('a');
  });

  it('is idempotent: re-running with the ledger updated yields an empty delta', async () => {
    const lines = [msg('a'), msg('b')];
    const first = await computeDelta(lines, { anchorUuid: null, legacyLineCursor: 0, lookupLedger: ledgerOf() });
    const second = await computeDelta(lines, {
      anchorUuid: first.lastUuid, legacyLineCursor: lines.length, lookupLedger: ledgerOf(...first.newUuids),
    });
    expect(second.deltaLines).toEqual([]);
    expect(second.hasMessages).toBe(false);
  });
});
