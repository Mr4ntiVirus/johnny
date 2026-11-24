import { describe, it, expect } from 'vitest';
import { useLocalSqlite } from '../helpers/sqlite.js';
import { embed, getEmbedModelName } from '../../src/utils/llm.js';
import * as modelsDb from '../../src/store/db/mental-models.js';
import * as obsDb from '../../src/store/db/observations.js';
import { upsertSession } from '../../src/store/db/sessions.js';
import { preToolHook, shouldConsiderCommand } from '../../src/cli/pre-tool.js';
import { getPrimeStats, getLastPrimeEvent } from '../../src/store/db/prime-events.js';
import { DEFAULT_KNOWLEDGE_CONFIG } from '../../src/knowledge/config.js';

const on = { ...DEFAULT_KNOWLEDGE_CONFIG, prime: true };
const CMD = 'aws ec2 describe-instances --region xx-region-1 --query Reservations[].Instances[].InstanceId';

describe('shouldConsiderCommand', () => {
  it('skips short and trivial commands, keeps substantive ones', () => {
    expect(shouldConsiderCommand('ls -la')).toBe(false);
    expect(shouldConsiderCommand('git status')).toBe(false);
    expect(shouldConsiderCommand('cd /tmp && ls')).toBe(false);
    expect(shouldConsiderCommand(CMD)).toBe(true);
    expect(shouldConsiderCommand('ssh -i ~/key.pem ubuntu@build.example.com docker ps')).toBe(true);
    expect(shouldConsiderCommand('git log --oneline --graph')).toBe(false);
  });
});

describe('preToolHook (mid-turn priming)', () => {
  useLocalSqlite();
  const payload = (over: Record<string, unknown> = {}) => ({
    session_id: 'pt-1', cwd: '/tmp/some-project', tool_name: 'Bash', tool_input: { command: CMD }, ...over,
  });

  async function seed() {
    const q = `AWS conventions. ${CMD}`;
    const oid = await obsDb.createObservation({ scope: 'global', text: 'AWS CLI calls must use --profile default; the shell sets AWS_PROFILE=work which breaks auth.' });
    await modelsDb.createModel({
      slug: 'aws-conventions', name: 'AWS conventions', sourceQuery: CMD, scope: 'global',
      queryEmbedding: await embed(CMD), embeddingModel: getEmbedModelName(),
    });
    await modelsDb.writeModelContent('aws-conventions', '## AWS\nAlways pass --profile default on aws CLI calls; the ambient AWS_PROFILE=work breaks authentication.', [oid], new Date().toISOString(), 't');
    await upsertSession({ sessionId: 'pt-1' });
    return q;
  }

  it('does nothing when the flag is off, for non-Bash tools, or for trivial commands', async () => {
    await seed();
    expect(await preToolHook(payload(), { ...DEFAULT_KNOWLEDGE_CONFIG, prime: false })).toEqual({});
    expect(await preToolHook(payload({ tool_name: 'Read' }), on)).toEqual({});
    expect(await preToolHook(payload({ tool_input: { command: 'ls' } }), on)).toEqual({});
    expect(await preToolHook(payload({ session_id: undefined }), on)).toEqual({});
  });

  it('injects a PreToolUse additionalContext digest once per context epoch', async () => {
    await seed();
    const out = await preToolHook(payload(), on) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.additionalContext).toContain('--profile default');
    // the very next aws call in the same session must not repeat it
    expect(await preToolHook(payload(), on)).toEqual({});
    // the decision is recorded for the doctor's KNOWLEDGE panel
    expect(await getPrimeStats(new Date(Date.now() - 60_000).toISOString())).toEqual({ evaluated: 1, primed: 1, failed: 0 });
    expect((await getLastPrimeEvent())?.outcome).toBe('primed');
  });

  it('scans at most once per minute per session (it runs on every shell command)', async () => {
    await seed();
    await preToolHook(payload({ tool_input: { command: 'some other substantive shell command here' } }), on); // claims the window
    const out = await preToolHook(payload(), on);   // would have primed, but the window is taken
    expect(out).toEqual({});
    // a different session has its own window
    await upsertSession({ sessionId: 'pt-2' });
    const other = await preToolHook(payload({ session_id: 'pt-2' }), on) as { hookSpecificOutput?: unknown };
    expect(other.hookSpecificOutput).toBeTruthy();
  });

  it('passes through when nothing relevant is known', async () => {
    expect(await preToolHook(payload(), on)).toEqual({});
  });
});
