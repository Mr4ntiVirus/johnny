import { describe, it, expect } from 'vitest';
import { extractSchemas } from '../../src/sleep/schema-extraction.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import { useTestDb } from '../helpers/db.js';
import type { Memory, MemoryGraph } from '../../src/types.js';

function makeMem(id: string, topics: string[], embedding: number[] | null = null): Memory {
  return {
    id, snapshotName: id, summary: `session about ${topics.join(', ')}`,
    embedding, topics, projectPath: '/dev/proj', tokenCount: 100,
    retrievalCount: 5, lastRetrievedTurn: 50, lastRetrievedAt: '',
    createdAtTurn: 1, createdAt: '',
    outgoingEdges: {}, incomingEdges: {},
    rank: 0.15, rankUpdatedAtTurn: 1,
  };
}

function makeGraph(...mems: Memory[]): MemoryGraph {
  const memories: Record<string, Memory> = {};
  for (const m of mems) memories[m.id] = m;
  return { version: 1, rankUpdatedAtTurn: 0, memories };
}

describe('extractSchemas', () => {
  useTestDb();

  it('creates a schema for a cluster of ≥3 topic-similar memories', async () => {
    // All share 3 of 4 topics → Jaccard = 3/5 = 0.6 ≥ 0.35
    const mems = [
      makeMem('a', ['roku', 'auth', 'api', 'token']),
      makeMem('b', ['roku', 'auth', 'api', 'refresh']),
      makeMem('c', ['roku', 'auth', 'api', 'login']),
    ];
    const graph = makeGraph(...mems);
    const result = await extractSchemas(graph, DEFAULT_CONFIG, 100);

    expect(result.schemasCreated).toBe(1);
    const schemas = Object.values(graph.memories).filter(m => m.snapshotName.startsWith('schema-'));
    expect(schemas).toHaveLength(1);
    expect(schemas[0].snapshotName).toMatch(/^schema-/);
  });

  it('schema has edges to all cluster members', async () => {
    const mems = [
      makeMem('a', ['docker', 'nginx', 'compose', 'deploy']),
      makeMem('b', ['docker', 'nginx', 'ssl', 'deploy']),
      makeMem('c', ['docker', 'nginx', 'proxy', 'compose']),
    ];
    const graph = makeGraph(...mems);
    await extractSchemas(graph, DEFAULT_CONFIG, 100);

    const schema = Object.values(graph.memories).find(m => m.snapshotName.startsWith('schema-'));
    expect(schema).toBeDefined();
    if (schema) {
      expect(Object.keys(schema.outgoingEdges)).toContain('a');
      expect(Object.keys(schema.outgoingEdges)).toContain('b');
      expect(Object.keys(schema.outgoingEdges)).toContain('c');
    }
  });

  it('does not create schema for fewer than 3 members', async () => {
    const mems = [
      makeMem('a', ['roku', 'auth', 'api']),
      makeMem('b', ['roku', 'auth', 'token']),
    ];
    const graph = makeGraph(...mems);
    const result = await extractSchemas(graph, DEFAULT_CONFIG, 100);
    expect(result.schemasCreated).toBe(0);
  });

  it('skips re-creating schema for same dominant topic', async () => {
    const mems = [
      makeMem('a', ['roku', 'auth', 'api', 'token']),
      makeMem('b', ['roku', 'auth', 'api', 'refresh']),
      makeMem('c', ['roku', 'auth', 'api', 'login']),
    ];
    // Pre-existing schema for the dominant topic
    const existingSchema = makeMem('schema-roku-0101', ['roku', 'auth']);
    existingSchema.snapshotName = 'schema-roku-0101';

    const graph = makeGraph(...mems, existingSchema);
    const result = await extractSchemas(graph, DEFAULT_CONFIG, 100);
    expect(result.schemasCreated).toBe(0);
  });

  it('does not cluster existing schema nodes as episodes', async () => {
    const schema = makeMem('schema-roku-0101', ['roku', 'auth', 'api']);
    schema.snapshotName = 'schema-roku-0101';
    const a = makeMem('a', ['roku', 'auth', 'api', 'token']);
    const b = makeMem('b', ['roku', 'auth', 'api', 'refresh']);
    const c = makeMem('c', ['roku', 'auth', 'api', 'login']);

    const graph = makeGraph(schema, a, b, c);
    const before = Object.keys(graph.memories).length;
    await extractSchemas(graph, DEFAULT_CONFIG, 100);
    // The existing schema-* node should not be clustered with the episodes
    // and since 'roku' schema already exists, no new schema created
    const after = Object.keys(graph.memories).length;
    expect(after).toBe(before); // no schema added
  });

  it('returns 0 when fewer than MIN_CLUSTER memories exist', async () => {
    const a = makeMem('a', ['roku', 'auth']);
    const graph = makeGraph(a);
    const result = await extractSchemas(graph, DEFAULT_CONFIG, 100);
    expect(result.schemasCreated).toBe(0);
  });
});
