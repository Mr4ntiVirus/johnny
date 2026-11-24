import { query, queryOne, execute } from '../db-client.js';
import { encodeEmbedding, decodeEmbedding } from '../../utils/embedding-codec.js';

export interface TranscriptInput {
  memoryId: string;
  transcript?: string;
  topics?: string[];
  embedding?: number[];
  embeddingModel?: string;
  contentFormat?: string;
  language?: string;
  mimeType?: string;
  dimensions?: string;
  filePath?: string;
  url?: string;
  fetchedAt?: string;
  skillName?: string;
  skillCommands?: string[];
  skillInstructions?: string;
  skillPrompt?: string;
  toolName?: string;
  toolParameters?: string;
  toolDescription?: string;
  toolCategory?: string;
  toolSchema?: string;
}

export interface TranscriptRecord {
  memory_id: string;
  transcript: string | null;
  embedding: Buffer | null;
  topics: string | null;
  updated_at: string | null;
  content_format: string | null;
  language: string | null;
  mime_type: string | null;
  dimensions: string | null;
  file_path: string | null;
  url: string | null;
  fetched_at: string | null;
  skill_name: string | null;
  skill_commands: string | null;
  skill_instructions: string | null;
  skill_prompt: string | null;
  tool_name: string | null;
  tool_parameters: string | null;
  tool_description: string | null;
  tool_category: string | null;
  tool_schema: string | null;
  embedding_model: string | null;
}

export async function createTranscript(input: TranscriptInput): Promise<void> {
  const embeddingBlob = input.embedding ? encodeEmbedding(input.embedding) : null;
  const topicsJson = input.topics ? JSON.stringify(input.topics) : null;
  const skillCommandsJson = input.skillCommands ? JSON.stringify(input.skillCommands) : null;
  await execute(
    `INSERT INTO transcripts (
       memory_id, transcript, embedding, embedding_model, topics, updated_at,
       content_format, language, mime_type, dimensions, file_path,
       url, fetched_at, skill_name, skill_commands, skill_instructions,
       skill_prompt, tool_name, tool_parameters, tool_description, tool_category, tool_schema
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.memoryId, input.transcript ?? null, embeddingBlob, input.embeddingModel ?? null, topicsJson,
     new Date().toISOString(), input.contentFormat ?? null, input.language ?? null,
     input.mimeType ?? null, input.dimensions ?? null, input.filePath ?? null, input.url ?? null,
     input.fetchedAt ?? null, input.skillName ?? null, skillCommandsJson, input.skillInstructions ?? null,
     input.skillPrompt ?? null, input.toolName ?? null, input.toolParameters ?? null,
     input.toolDescription ?? null, input.toolCategory ?? null, input.toolSchema ?? null],
  );
}

export async function getTranscript(memoryId: string): Promise<TranscriptRecord | null> {
  return queryOne<TranscriptRecord>('SELECT * FROM transcripts WHERE memory_id = ?', [memoryId]);
}

export async function getTranscriptWithTopics(memoryId: string): Promise<(TranscriptRecord & { topicsArray: string[] }) | null> {
  const record = await getTranscript(memoryId);
  if (!record) return null;
  return { ...record, topicsArray: record.topics ? JSON.parse(record.topics) : [] };
}

export async function updateTranscript(memoryId: string, updates: Partial<TranscriptInput>): Promise<void> {
  const fields: string[] = ['updated_at = ?'];
  const values: (string | Buffer | null)[] = [new Date().toISOString()];

  if (updates.transcript !== undefined) { fields.push('transcript = ?'); values.push(updates.transcript ?? null); }
  if (updates.topics !== undefined) { fields.push('topics = ?'); values.push(updates.topics ? JSON.stringify(updates.topics) : null); }
  if (updates.embedding !== undefined) { fields.push('embedding = ?'); values.push(updates.embedding ? encodeEmbedding(updates.embedding) : null); }
  if (updates.embeddingModel !== undefined) { fields.push('embedding_model = ?'); values.push(updates.embeddingModel ?? null); }
  if (updates.contentFormat !== undefined) { fields.push('content_format = ?'); values.push(updates.contentFormat ?? null); }
  if (updates.language !== undefined) { fields.push('language = ?'); values.push(updates.language ?? null); }
  if (updates.filePath !== undefined) { fields.push('file_path = ?'); values.push(updates.filePath ?? null); }
  if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url ?? null); }
  if (updates.skillName !== undefined) { fields.push('skill_name = ?'); values.push(updates.skillName ?? null); }
  if (updates.skillCommands !== undefined) { fields.push('skill_commands = ?'); values.push(updates.skillCommands ? JSON.stringify(updates.skillCommands) : null); }
  if (updates.skillInstructions !== undefined) { fields.push('skill_instructions = ?'); values.push(updates.skillInstructions ?? null); }
  if (updates.toolName !== undefined) { fields.push('tool_name = ?'); values.push(updates.toolName ?? null); }
  if (updates.toolDescription !== undefined) { fields.push('tool_description = ?'); values.push(updates.toolDescription ?? null); }
  if (updates.toolCategory !== undefined) { fields.push('tool_category = ?'); values.push(updates.toolCategory ?? null); }
  if (updates.toolSchema !== undefined) { fields.push('tool_schema = ?'); values.push(updates.toolSchema ?? null); }

  values.push(memoryId);
  await execute(`UPDATE transcripts SET ${fields.join(', ')} WHERE memory_id = ?`, values);
}

export async function deleteTranscript(memoryId: string): Promise<void> {
  await execute('DELETE FROM transcripts WHERE memory_id = ?', [memoryId]);
}

export async function getTranscriptText(memoryId: string): Promise<string | null> {
  const record = await getTranscript(memoryId);
  return record?.transcript ?? null;
}

export async function setEmbedding(memoryId: string, embedding: number[], model?: string): Promise<void> {
  const now = new Date().toISOString();
  const blob = encodeEmbedding(embedding);
  const existing = await queryOne<{ memory_id: string }>('SELECT memory_id FROM transcripts WHERE memory_id = ?', [memoryId]);
  if (existing) {
    await execute('UPDATE transcripts SET embedding = ?, embedding_model = ?, updated_at = ? WHERE memory_id = ?', [blob, model ?? null, now, memoryId]);
  } else {
    await execute('INSERT INTO transcripts (memory_id, embedding, embedding_model, updated_at) VALUES (?, ?, ?, ?)', [memoryId, blob, model ?? null, now]);
  }
}

export async function getEmbeddingsByIds(ids: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query<{ memory_id: string; embedding: Buffer }>(
    `SELECT memory_id, embedding FROM transcripts WHERE memory_id IN (${placeholders}) AND embedding IS NOT NULL`,
    ids,
  );
  for (const row of rows) {
    try { out.set(row.memory_id, decodeEmbedding(row.embedding)); } catch { /* malformed */ }
  }
  return out;
}

export async function getAllTopicsByMemory(): Promise<Map<string, string[]>> {
  const rows = await query<{ memory_id: string; topics: string }>('SELECT memory_id, topics FROM transcripts WHERE topics IS NOT NULL');
  const map = new Map<string, string[]>();
  for (const row of rows) {
    try { map.set(row.memory_id, JSON.parse(row.topics) as string[]); } catch { /* malformed */ }
  }
  return map;
}

export async function getAllTopics(): Promise<string[]> {
  const rows = await query<{ topics: string }>('SELECT topics FROM transcripts WHERE topics IS NOT NULL');
  const allTopics = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.topics) as string[];
      for (const topic of parsed) if (topic.length > 2) allTopics.add(topic);
    } catch { /* malformed */ }
  }
  return Array.from(allTopics).sort();
}

export async function getMemoriesByTopic(topic: string, limit = 10): Promise<string[]> {
  const rows = await query<{ memory_id: string }>(
    `SELECT t.memory_id FROM transcripts t WHERE t.topics LIKE ? LIMIT ?`,
    [`%"${topic}"%`, limit],
  );
  return rows.map(r => r.memory_id);
}

// Loads all transcript metadata WITHOUT embedding blobs (saves ~2.3MB on slow networks).
// Embeddings are loaded on-demand per-candidate via getEmbeddingsByIds.
export async function getAllTranscripts(): Promise<Map<string, TranscriptRecord>> {
  const rows = await query<TranscriptRecord>(
    `SELECT memory_id, transcript, topics, updated_at, content_format, language, mime_type,
            dimensions, file_path, url, fetched_at, skill_name, skill_commands,
            skill_instructions, skill_prompt, tool_name, tool_parameters, tool_description,
            tool_category, tool_schema, embedding_model
     FROM transcripts`,
  );
  return new Map(rows.map(r => [r.memory_id, r]));
}

export async function getSkills(): Promise<TranscriptRecord[]> {
  return query<TranscriptRecord>(`SELECT t.* FROM transcripts t JOIN memories m ON m.id = t.memory_id WHERE m.content_type = 'skill'`);
}

export async function getTools(): Promise<TranscriptRecord[]> {
  return query<TranscriptRecord>(`SELECT t.* FROM transcripts t JOIN memories m ON m.id = t.memory_id WHERE m.content_type = 'tool'`);
}
