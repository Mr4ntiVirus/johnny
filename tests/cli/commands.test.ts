// Phase D — CLI command integration tests. Drives each command's exported
// main function against a seeded DB and asserts on captured stdout/stderr
// plus DB side effects. HOME sandboxed per-test to isolate CMV writes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { useTestDb } from '../helpers/db.js';
import { addMemory, listMemories } from '../../src/store/memory.js';
import { setDatabasePath } from '../../src/store/database.js';

// ── IO capture ───────────────────────────────────────────────────────────────

async function captureIO(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  (process.stdout.write as any) = (chunk: any) => { stdout += chunk.toString(); return true; };
  (process.stderr.write as any) = (chunk: any) => { stderr += chunk.toString(); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout, stderr };
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('CLI commands', () => {
  useTestDb();

  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-cmd-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── cmdStatus ──────────────────────────────────────────────────────────────

  describe('cmdStatus', () => {
    it('renders without crashing on an empty DB', async () => {
      const { cmdStatus } = await import('../../src/cli/commands/status.js');
      const { stdout } = await captureIO(cmdStatus);
      expect(stdout).toMatch(/STATUS/);
      expect(stdout).toMatch(/MEMORIES/);
    });

    it('reflects seeded memory count', async () => {
      await addMemory('mem-a', 'Alpha', 'first', 't1', '/tmp/a', 10, ['alpha'], 1);
      await addMemory('mem-b', 'Beta',  'second','t2', '/tmp/b', 10, ['beta'],  1);
      const { cmdStatus } = await import('../../src/cli/commands/status.js');
      const { stdout } = await captureIO(cmdStatus);
      expect(stdout).toMatch(/MEMORIES.*2/);
    });
  });

  // ── cmdGraph ───────────────────────────────────────────────────────────────

  describe('cmdGraph', () => {
    it('shows empty-state message when no memories exist', async () => {
      const { cmdGraph } = await import('../../src/cli/commands/graph.js');
      const { stdout } = await captureIO(() => cmdGraph([]));
      expect(stdout).toMatch(/nothing in the wetware/);
    });

    it('lists memories with title + rank columns', async () => {
      await addMemory('cdk-refactor', 'CDK wake portal refactor', 'summary', 't', '/tmp', 100, ['cdk'], 1);
      const { cmdGraph } = await import('../../src/cli/commands/graph.js');
      const { stdout } = await captureIO(() => cmdGraph([]));
      expect(stdout).toMatch(/CDK wake portal/);
      expect(stdout).toMatch(/1 memories/);
    });

    it('emits valid JSON with --json', async () => {
      await addMemory('slug-x', 'Title X', 'sum', 't', '/tmp', 50, ['x'], 1);
      const { cmdGraph } = await import('../../src/cli/commands/graph.js');
      const { stdout } = await captureIO(() => cmdGraph(['--json']));
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toMatchObject({ title: 'Title X', slug: 'slug-x' });
    });
  });

  // ── cmdRecall ──────────────────────────────────────────────────────────────

  describe('cmdRecall', () => {
    // cmdRecall forces JOHNNY_LOCAL_STORE=1 (it's the hot-path command), which
    // routes reads through local-db.ts's getDatabase(). Point that at a fresh
    // :memory: SQLite DB so addMemory() (also routed via JOHNNY_LOCAL_STORE)
    // seeds the same DB cmdRecall reads, instead of the developer's real ~/.johnny/johnny.db.
    beforeEach(() => {
      setDatabasePath(':memory:');
      process.env.JOHNNY_LOCAL_STORE = '1';
    });

    afterEach(() => {
      delete process.env.JOHNNY_LOCAL_STORE;
    });

    it('prints usage hint when no query or flag given', async () => {
      await addMemory('m1', 'Title', 'summary', 't', '/tmp', 10, ['topic'], 1);
      const { cmdRecall } = await import('../../src/cli/commands/recall.js');
      const { stdout } = await captureIO(() => cmdRecall([]));
      expect(stdout).toMatch(/usage/);
    });

    it('--list lists seeded memories', async () => {
      await addMemory('alpha-slug', 'Alpha', 'first memory', 't', '/tmp/a', 10, ['alpha', 'one'], 1);
      await addMemory('beta-slug',  'Beta',  'second memory','t', '/tmp/b', 10, ['beta', 'two'],  1);
      const { cmdRecall } = await import('../../src/cli/commands/recall.js');
      const { stdout } = await captureIO(() => cmdRecall(['--list']));
      expect(stdout).toMatch(/Alpha/);
      expect(stdout).toMatch(/Beta/);
      expect(stdout).toMatch(/showing 2 of 2 subjects/);
    });

    it('falls back to keyword match when query matches a topic', async () => {
      await addMemory('roku-auth-fix', 'Roku auth fix', 'roku 401', 'transcript', '/tmp/roku', 10, ['roku', 'auth'], 1);
      const { cmdRecall } = await import('../../src/cli/commands/recall.js');
      const { stdout } = await captureIO(() => cmdRecall(['roku', 'auth']));
      expect(stdout).toMatch(/roku-auth-fix/);
      expect(stdout).toMatch(/keyword/);
    });

    it('reports "no match" when nothing overlaps', async () => {
      await addMemory('foo', 'Foo', 'bar', 't', '/tmp', 10, ['unrelated'], 1);
      const { cmdRecall } = await import('../../src/cli/commands/recall.js');
      const { stdout } = await captureIO(() => cmdRecall(['completely', 'different']));
      expect(stdout).toMatch(/no match/);
    });

    it('empty-state message when no memories exist', async () => {
      const { cmdRecall } = await import('../../src/cli/commands/recall.js');
      const { stdout } = await captureIO(() => cmdRecall(['anything']));
      expect(stdout).toMatch(/nothing in the wetware/);
    });
  });

  // ── cmdRemember ────────────────────────────────────────────────────────────

  describe('cmdRemember', () => {
    it('persists a memory via --content arg (regression: previously dropped all writes)', async () => {
      const { cmdRemember } = await import('../../src/cli/commands/remember.js');
      await captureIO(() =>
        cmdRemember(['Alice AWS profile', '--content=always export AWS_PROFILE=demo before cdk deploys']),
      );
      const memories = await listMemories();
      expect(memories).toHaveLength(1);
      expect(memories[0].title).toBe('Alice AWS profile');
      expect(memories[0].snapshotName).toBe('alice-aws-profile');
    });
  });

  // ── cmdSleep ───────────────────────────────────────────────────────────────

  describe('cmdSleep', () => {
    it('runs without throwing when the graph is empty', async () => {
      const { cmdSleep } = await import('../../src/cli/commands/sleep.js');
      await expect(captureIO(cmdSleep)).resolves.toBeDefined();
    });
  });

  // ── cmdRollback ────────────────────────────────────────────────────────────

  // Tests deliberately omitted for commands that reach into ~/.cmv/ or
  // ~/.johnny/ via os.homedir() or frozen PATHS:
  //   - cmdRollback, cmdSnapshotNow, cmdDump — use CMV paths via os.homedir().
  //     Under vitest, os.homedir() is NOT sandboxed by process.env.HOME overrides
  //     (Node caches the passwd lookup at process start), so these tests would
  //     touch the user's real CMV snapshots and active session.
  //   - cmdDaemon — uses PATHS.daemonPid frozen at module import to the real
  //     ~/.johnny/daemon.pid; a stop test would kill the user's live daemon.
  //   - cmdInstall / cmdUninstall / cmdSetup / cmdBootstrap / cmdLaunch —
  //     mutate ~/.claude/settings.json or pull models or spawn processes.
  // Those paths are verified end-to-end in the Phase F manual smoke test and
  // in Phase E via the modules they call.
});
