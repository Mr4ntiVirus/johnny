import { describe, it, expect } from 'vitest';
import { useTestDb } from '../../helpers/db.js';
import * as memoriesDb from '../../../src/store/db/memories.js';
import * as transcriptsDb from '../../../src/store/db/transcripts.js';
import { decodeEmbedding } from '../../../src/utils/embedding-codec.js';

async function seedMemory(
  slug: string,
  contentType: 'text' | 'skill' | 'tool' = 'text',
): Promise<string> {
  return memoriesDb.createMemory({
    snapshotName: slug,
    title: slug,
    summary: slug,
    contentType,
    projectPath: '/tmp',
    tokenCount: 10,
    createdAtTurn: 1,
  });
}

describe('db/transcripts.ts', () => {
  useTestDb();

  it('createTranscript persists with topics + transcript', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: 'full body text',
      topics: ['alpha', 'beta'],
    });
    const row = await transcriptsDb.getTranscript(id);
    expect(row?.transcript).toBe('full body text');
    expect(row?.topics).toBe('["alpha","beta"]');
    expect(row?.updated_at).toBeTruthy();
  });

  it('getTranscript returns null for missing memory', async () => {
    expect(await transcriptsDb.getTranscript('nope')).toBeNull();
  });

  it('PK(memory_id) prevents duplicate transcripts', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({ memoryId: id, transcript: 'a' });
    await expect(
      transcriptsDb.createTranscript({ memoryId: id, transcript: 'b' }),
    ).rejects.toThrow();
  });

  it('FK to memories: insert with unknown memoryId throws', async () => {
    await expect(
      transcriptsDb.createTranscript({ memoryId: 'ghost', transcript: 'x' }),
    ).rejects.toThrow();
  });

  it('deleting a memory cascades to transcripts', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({ memoryId: id, transcript: 'x' });
    await memoriesDb.deleteMemory(id);
    expect(await transcriptsDb.getTranscript(id)).toBeNull();
  });

  it('getTranscriptText returns raw transcript', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({ memoryId: id, transcript: 'hello' });
    expect(await transcriptsDb.getTranscriptText(id)).toBe('hello');
  });

  it('getTranscriptText null when no transcript stored', async () => {
    expect(await transcriptsDb.getTranscriptText('nope')).toBeNull();
  });

  it('getTranscriptWithTopics parses topics JSON', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: 'x',
      topics: ['one', 'two'],
    });
    const row = await transcriptsDb.getTranscriptWithTopics(id);
    expect(row?.topicsArray).toEqual(['one', 'two']);
  });

  it('embedding BLOB round-trips as raw float32 binary', async () => {
    const id = await seedMemory('m1');
    const embedding = [0.1, 0.2, 0.3];
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: 'x',
      embedding,
    });
    const row = await transcriptsDb.getTranscript(id);
    expect(Buffer.isBuffer(row?.embedding)).toBe(true);
    // float32 storage loses float64 precision — compare against the same
    // Float32Array round-trip rather than the original float64 literals.
    const expected = Array.from(new Float32Array(embedding));
    const decoded = decodeEmbedding(row!.embedding!);
    expect(decoded).toEqual(expected);
  });

  it('updateTranscript overwrites transcript and topics', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: 'old',
      topics: ['a'],
    });
    await transcriptsDb.updateTranscript(id, {
      transcript: 'new',
      topics: ['b', 'c'],
    });
    const row = await transcriptsDb.getTranscript(id);
    expect(row?.transcript).toBe('new');
    expect(row?.topics).toBe('["b","c"]');
  });

  it('updateTranscript leaves unchanged fields alone', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({
      memoryId: id,
      transcript: 'original',
      topics: ['keep'],
    });
    await transcriptsDb.updateTranscript(id, { transcript: 'modified' });
    const row = await transcriptsDb.getTranscript(id);
    expect(row?.transcript).toBe('modified');
    expect(row?.topics).toBe('["keep"]');
  });

  it('deleteTranscript removes only the transcript', async () => {
    const id = await seedMemory('m1');
    await transcriptsDb.createTranscript({ memoryId: id, transcript: 'x' });
    await transcriptsDb.deleteTranscript(id);
    expect(await transcriptsDb.getTranscript(id)).toBeNull();
    expect(await memoriesDb.getMemory(id)).not.toBeNull();
  });

  it('getAllTopics aggregates unique topics across memories', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    await transcriptsDb.createTranscript({
      memoryId: a,
      topics: ['alpha', 'beta', 'gamma'],
    });
    await transcriptsDb.createTranscript({
      memoryId: b,
      topics: ['beta', 'delta'],
    });
    const topics = await transcriptsDb.getAllTopics();
    expect(topics).toEqual(['alpha', 'beta', 'delta', 'gamma']);
  });

  it('getMemoriesByTopic returns matching memory ids (not raw rows)', async () => {
    const a = await seedMemory('a');
    const b = await seedMemory('b');
    const c = await seedMemory('c');
    await transcriptsDb.createTranscript({ memoryId: a, topics: ['mammal'] });
    await transcriptsDb.createTranscript({ memoryId: b, topics: ['reptile'] });
    await transcriptsDb.createTranscript({ memoryId: c, topics: ['mammal', 'dog'] });

    const ids = await transcriptsDb.getMemoriesByTopic('mammal');
    expect(ids.sort()).toEqual([a, c].sort());
    // Confirms the cast bug is fixed — these are strings, not {memory_id:string}
    expect(typeof ids[0]).toBe('string');
  });

  it('getSkills returns only skill-typed memories', async () => {
    const s = await seedMemory('skill1', 'skill');
    const t = await seedMemory('text1', 'text');
    await transcriptsDb.createTranscript({
      memoryId: s,
      skillName: 'deploy',
      skillInstructions: 'run X',
    });
    await transcriptsDb.createTranscript({ memoryId: t, transcript: 'note' });

    const skills = await transcriptsDb.getSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].skill_name).toBe('deploy');
  });

  it('getTools returns only tool-typed memories', async () => {
    const u = await seedMemory('tool1', 'tool');
    const v = await seedMemory('text2', 'text');
    await transcriptsDb.createTranscript({
      memoryId: u,
      toolName: 'grep',
      toolDescription: 'search',
    });
    await transcriptsDb.createTranscript({ memoryId: v, transcript: 'note' });

    const tools = await transcriptsDb.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].tool_name).toBe('grep');
  });

  it('skillCommands JSON round-trip', async () => {
    const id = await seedMemory('skill', 'skill');
    await transcriptsDb.createTranscript({
      memoryId: id,
      skillName: 's',
      skillCommands: ['build', 'deploy'],
    });
    const row = await transcriptsDb.getTranscript(id);
    expect(JSON.parse(row!.skill_commands!)).toEqual(['build', 'deploy']);
  });
});
