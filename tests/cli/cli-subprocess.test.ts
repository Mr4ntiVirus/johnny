// Subprocess smoke tests for the johnny CLI. In-process imports don't
// exercise Node's ESM loader, so they miss bugs like "tsc emitted .jsx and
// Node has no loader for that extension" — which crashed `johnny graph --tui`
// after a tsconfig change. These tests spawn the real compiled entry point
// to catch those.
//
// Pure exit-code/stdout checks — no DB or HOME assumptions, so safe to run
// against the real ~/.johnny/. Commands that mutate user state (install,
// rollback, snapshot-now, daemon start) are exercised only via --help.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const CLI = path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], opts: { timeoutMs?: number; killSignal?: NodeJS.Signals } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, JOHNNY_BYPASS: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.end();
    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill(opts.killSignal ?? 'SIGTERM'), opts.timeoutMs)
      : null;
    proc.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// Skip if dist isn't built — these tests assume `npm run build` has run.
const hasDist = fs.existsSync(CLI);
const d = hasDist ? describe : describe.skip;

d('johnny CLI subprocess smoke', () => {
  it('johnny --help prints command list', async () => {
    const r = await run(['--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agentic memory librarian/);
    expect(r.stdout).toMatch(/graph/);
    expect(r.stdout).toMatch(/recall/);
  });

  it('johnny help (no dashes) also works', async () => {
    const r = await run(['help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/commands:/);
  });

  it('johnny graph --help prints graph usage and exits 0', async () => {
    const r = await run(['graph', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/inspect the memory graph/);
    expect(r.stdout).toMatch(/--tui/);
  });

  it('johnny graph --json produces valid JSON', async () => {
    const r = await run(['graph', '--json'], { timeoutMs: 10000 });
    expect(r.code).toBe(0);
    // Either an array (memories present) or empty-state text — but if
    // anything is on stdout, it must be parseable JSON or the empty hint.
    if (r.stdout.trim().startsWith('[')) {
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
  });

  it('johnny graph rejects unknown flags with the help text', async () => {
    const r = await run(['graph', '--export', 'dot'], { timeoutMs: 5000 });
    // exit 0 is fine — we print help and return; key thing is the error message.
    expect(r.stderr).toMatch(/unknown flag/);
    expect(r.stdout).toMatch(/inspect the memory graph/);
  });

  it('johnny graph --tui loads (regression: ERR_UNKNOWN_FILE_EXTENSION on .jsx)', async () => {
    // We can't drive raw-mode Ink without a TTY, but we CAN verify the
    // dynamic import resolves and the module loads. Kill after 800ms and
    // check stderr doesn't contain a module-resolution crash.
    const r = await run(['graph', '--tui'], { timeoutMs: 800, killSignal: 'SIGTERM' });
    // The crash signature we're guarding against:
    expect(r.stderr).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/);
    expect(r.stderr).not.toMatch(/Cannot find module.*graph-tui/);
    // Ink itself may complain about raw mode without a TTY — that's expected
    // and proves the module DID load.
  });

  it('johnny recall --help prints recall usage', async () => {
    const r = await run(['recall', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/search and surface/);
    expect(r.stdout).toMatch(/--switch/);
  });

  it('johnny remember --help prints remember usage and does NOT prompt for stdin', async () => {
    // Regression: previously --help was treated as the title and the command
    // hung waiting on stdin. Timeout would catch the hang; we close stdin
    // immediately so a hang manifests as no stdout match.
    const r = await run(['remember', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/save a memory manually/);
  });

  it('johnny status --help short-circuits to global usage (does not run status)', async () => {
    const r = await run(['status', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agentic memory librarian/);
    // Status output would include MEMORIES; help should not.
    expect(r.stdout).not.toMatch(/MEMORIES.*\d+/);
  });

  it('johnny install --help does not actually install', async () => {
    const r = await run(['install', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agentic memory librarian/);
    // Install action would log to stderr about writing settings.json — the
    // help text doesn't mention that path, so it's a clean negative signal.
    expect(r.stderr).not.toMatch(/settings\.json/);
  });

  it('johnny rollback --help does not actually roll back', async () => {
    const r = await run(['rollback', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agentic memory librarian/);
    // The actual rollback action writes "restored" / "× rollback failed"
    // glyphs to stderr — none of which appear in the help text.
    expect(r.stderr).not.toMatch(/restored|rollback failed/i);
  });

  it('johnny daemon --help does not start the daemon', async () => {
    const r = await run(['daemon', '--help'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agentic memory librarian/);
  });

  it('johnny on an unknown command exits 1 with usage', async () => {
    const r = await run(['definitely-not-a-command'], { timeoutMs: 5000 });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown command/);
    expect(r.stderr).toMatch(/commands:/);
  });

  // Every hook is loaded on demand by the router. JOHNNY_BYPASS=1 (set by run()) makes each hook
  // write {} and exit 0 before any work, so this proves the case dispatches and the module resolves.
  it.each(['evaluate', 'pre-compact', 'post-compact', 'post-turn', 'pre-tool'])(
    'hook %s is dispatched by the router (bypass → {} and exit 0)',
    async (hook) => {
      const r = await run([hook], { timeoutMs: 5000 });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('{}');
      expect(r.stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
    },
  );
});

// Hooks fire on every prompt and every tool call. The router used to import all 38 command and
// hook modules up front, which was ~150 ms of a ~200 ms hook call. A dynamic import() inside a
// case is fine; a static import of a project module is what brings the cost back.
describe('johnny CLI router startup cost', () => {
  it('has no static imports of project modules (commands and hooks load on demand)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'index.ts'), 'utf-8');
    const staticRelative = src.match(/^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+['"]\.\.?\/[^'"]*['"]/gm) ?? [];
    expect(staticRelative).toEqual([]);
  });
});
