// Tests for the PostCompact hook handler.
// Mirrors the pre-compact.test.ts pattern: captureStdout + withStdin helpers,
// useTestDb(), tmpHome/tmpDir setup for filesystem isolation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setDatabasePath } from '../../src/store/database.js';
import { runPostCompact } from '../../src/cli/post-compact.js';
import { addMemory } from '../../src/store/memory.js';
import { embedMemory } from '../../src/engine/embedder.js';
import { hasMemoryBeenSurfaced } from '../../src/store/session-map.js';

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as any) = (chunk: any) => {
      buf += chunk.toString();
      return true;
    };
    fn()
      .then(() => { process.stdout.write = original; resolve(buf); })
      .catch(err => { process.stdout.write = original; reject(err); });
  });
}

async function withStdin<T>(input: string, fn: () => Promise<T>): Promise<T> {
  const { Readable } = await import('node:stream');
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([input]) });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'stdin', original);
  }
}

// A compact summary ≥100 chars that shares enough terms with the test memory
// for mock embeddings (char-code hash) to score above 0.50.
const LONG_SUMMARY =
  'Debugging the roku auth OAuth 2.0 token refresh flow. The device_code and user_code ' +
  'are read from SceneGraph. The 401 handling was fixed by reading the token from the ' +
  'SceneGraph node registry instead of channel params. All test cases pass.';

describe('runPostCompact', () => {
  // Post-compact hook runs with JOHNNY_LOCAL_STORE=1 (SQLite, not Postgres).
  // Use an in-memory SQLite DB per test — no remote connection needed.
  let tmpHome: string;
  let tmpDir: string;
  let transcriptPath: string;
  let originalHome: string | undefined;
  let originalLocalStore: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalLocalStore = process.env.JOHNNY_LOCAL_STORE;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-poc-home-'));
    tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-poc-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    process.env.HOME = tmpHome;
    process.env.JOHNNY_LOCAL_STORE = '1';
    setDatabasePath(':memory:');
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalLocalStore !== undefined) process.env.JOHNNY_LOCAL_STORE = originalLocalStore;
    else delete process.env.JOHNNY_LOCAL_STORE;
    setDatabasePath(':memory:'); // reset singleton so next suite starts clean
    for (const d of [tmpHome, tmpDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── Guards ───────────────────────────────────────────────────────────────────

  it('returns {} on invalid JSON stdin', async () => {
    const out = await captureStdout(() => withStdin('not-json', runPostCompact));
    expect(out).toBe('{}');
  });

  it('returns {} when payload lacks transcript_path', async () => {
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ session_id: 'x' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when payload lacks session_id', async () => {
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ transcript_path: '/nonexistent/path.jsonl' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when transcript file does not exist', async () => {
    const out = await captureStdout(() =>
      withStdin(
        JSON.stringify({ transcript_path: path.join(tmpDir, 'missing.jsonl'), session_id: 'sess' }),
        runPostCompact,
      ),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when compact summary is too short (< 100 chars)', async () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', summary: 'Short.' }) + '\n',
    );
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when transcript has no compact boundary', async () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }) + '\n',
    );
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when compact boundary is followed by user messages (stale compact)', async () => {
    const compact = JSON.stringify({ type: 'system', subtype: 'compact_boundary', summary: LONG_SUMMARY });
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'next' }] } });
    fs.writeFileSync(transcriptPath, compact + '\n' + user + '\n');
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  it('returns {} when no memories exist in the graph', async () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', summary: LONG_SUMMARY }) + '\n',
    );
    const out = await captureStdout(() =>
      withStdin(JSON.stringify({ transcript_path: transcriptPath, session_id: 'sess' }), runPostCompact),
    );
    expect(out).toBe('{}');
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  it('injects matching memory body into transcript after compact', async () => {
    // Seed a memory whose summary shares terms with LONG_SUMMARY so mock
    // embeddings (char-code hash) score above the 0.50 threshold.
    const mem = await addMemory(
      'roku-auth-token',
      'Roku auth token refresh',
      'roku auth token refresh OAuth device_code user_code SceneGraph 401 handling',
      'transcript', tmpDir, 800,
      ['roku', 'auth', 'token'], 1,
    );
    await embedMemory(mem);

    // Create a minimal CMV snapshot so buildMemoryBodyEntries can load the body.
    // With HOME=tmpHome, CMV reads/writes under tmpHome/.cmv/
    const snapshotSession = path.join(tmpHome, '.cmv', 'snapshots', 'snap-001', 'session');
    fs.mkdirSync(snapshotSession, { recursive: true });
    fs.writeFileSync(
      path.join(snapshotSession, 'sess-001.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'roku auth context' }] } }) + '\n',
    );
    fs.writeFileSync(
      path.join(tmpHome, '.cmv', 'index.json'),
      JSON.stringify({
        snapshots: {
          'roku-auth-token': {
            snapshot_dir: 'snap-001',
            source_session_id: 'sess-001',
            token_count: 100,
            created_at: new Date().toISOString(),
          },
        },
      }),
    );

    // Transcript: fresh compact boundary, no trailing user messages.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', summary: LONG_SUMMARY }) + '\n',
    );

    const linesBefore = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean).length;

    const out = await captureStdout(() =>
      withStdin(
        JSON.stringify({ transcript_path: transcriptPath, session_id: 'test-sess', cwd: tmpDir }),
        runPostCompact,
      ),
    );

    expect(out).toBe('{}');
    const linesAfter = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean).length;
    expect(linesAfter).toBeGreaterThan(linesBefore);
    expect(await hasMemoryBeenSurfaced('test-sess', mem.id)).toBe(true);
  });

  // ── Dedupe ───────────────────────────────────────────────────────────────────

  it('skips already-surfaced memory on second run', async () => {
    const mem = await addMemory(
      'roku-auth-token-2',
      'Roku auth token refresh',
      'roku auth token refresh OAuth device_code user_code SceneGraph 401 handling',
      'transcript', tmpDir, 800,
      ['roku', 'auth', 'token'], 1,
    );
    await embedMemory(mem);

    const snapshotSession = path.join(tmpHome, '.cmv', 'snapshots', 'snap-002', 'session');
    fs.mkdirSync(snapshotSession, { recursive: true });
    fs.writeFileSync(
      path.join(snapshotSession, 'sess-002.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'roku auth context' }] } }) + '\n',
    );
    fs.writeFileSync(
      path.join(tmpHome, '.cmv', 'index.json'),
      JSON.stringify({
        snapshots: {
          'roku-auth-token-2': {
            snapshot_dir: 'snap-002',
            source_session_id: 'sess-002',
            token_count: 100,
            created_at: new Date().toISOString(),
          },
        },
      }),
    );

    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', summary: LONG_SUMMARY }) + '\n',
    );

    const payload = JSON.stringify({ transcript_path: transcriptPath, session_id: 'dedup-sess', cwd: tmpDir });

    // First run — should inject.
    await captureStdout(() => withStdin(payload, runPostCompact));
    const linesAfterFirst = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean).length;
    expect(await hasMemoryBeenSurfaced('dedup-sess', mem.id)).toBe(true);

    // Second run — should skip (already surfaced).
    await captureStdout(() => withStdin(payload, runPostCompact));
    const linesAfterSecond = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean).length;
    expect(linesAfterSecond).toBe(linesAfterFirst);
  });
});
