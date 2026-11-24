import type { MemoryId, MemoryNode, JohnnyConfig } from '../types.js';
import type { ContentType } from './database.js';
import * as memoriesDb from './db/memories.js';
import * as transcriptsDb from './db/transcripts.js';
import * as edgesDb from './db/edges.js';
import { slugify } from '../utils/slugify.js';

export interface AddMemoryOptions {
  snapshotName?: string;
  title: string;
  summary?: string;
  transcript: string;
  projectPath?: string;
  tokenCount?: number;
  topics?: string[];
  contentType?: 'text' | 'markdown' | 'code' | 'webpage' | 'image' | 'plan' | 'doc' | 'skill' | 'tool' | 'schema';
  language?: string;
  sourceUri?: string;
  currentTurn?: number;
}

export async function addMemory(
  snapshotName: string,
  title: string,
  summary: string,
  transcript: string,
  projectPath: string,
  tokenCount: number,
  topics: string[],
  currentTurn: number,
  sourceUri?: string,
  contentType?: ContentType,
): Promise<MemoryNode> {
  const finalSnapshotName = slugify(snapshotName);
  const id = await memoriesDb.createMemory({
    snapshotName: finalSnapshotName,
    title,
    summary,
    contentType: (contentType ?? 'text') as ContentType,
    projectPath,
    sourceUri,
    tokenCount,
    createdAtTurn: currentTurn,
  });
  await transcriptsDb.createTranscript({ memoryId: id, transcript, topics });

  const now = new Date().toISOString();
  return {
    id: id as MemoryId,
    snapshotName: finalSnapshotName,
    title,
    summary,
    projectPath,
    sourceUri: sourceUri ?? null,
    tokenCount,
    topics,
    retrievalCount: 0,
    lastRetrievedTurn: 0,
    lastRetrievedAt: '',
    createdAtTurn: currentTurn,
    createdAt: now,
    outgoingEdges: {},
    incomingEdges: {},
    rank: 0.15,
    rankUpdatedAtTurn: currentTurn,
  };
}

export async function getMemoryById(id: string): Promise<{
  id: string; snapshotName: string; title: string; summary: string | null;
  transcript: string | null; topics: string[]; contentType: string;
  rank: number; retrievalCount: number; projectPath: string | null;
  sourceUri: string | null; tokenCount: number; createdAt: string; createdAtTurn: number | null;
} | null> {
  const mem = await memoriesDb.getMemory(id);
  if (!mem) return null;
  const [transcript, transcriptRec] = await Promise.all([
    transcriptsDb.getTranscriptText(id),
    transcriptsDb.getTranscript(id),
  ]);
  return {
    id: mem.id, snapshotName: mem.snapshot_name, title: mem.title, summary: mem.summary,
    transcript, topics: transcriptRec?.topics ? JSON.parse(transcriptRec.topics) : [],
    contentType: mem.content_type, rank: mem.rank, retrievalCount: mem.retrieval_count,
    projectPath: mem.project_path, sourceUri: mem.source_uri, tokenCount: mem.token_count,
    createdAt: mem.created_at, createdAtTurn: mem.created_at_turn,
  };
}

export async function getMemory(id: MemoryId): Promise<ReturnType<typeof getMemoryById>> {
  return getMemoryById(id);
}

export async function touchMemory(
  id: string,
  currentTurn: number,
  config: JohnnyConfig,
  coRetrievedIds: MemoryId[] = [],
): Promise<void> {
  await memoriesDb.recordRetrieval(id, currentTurn);
  await Promise.all(
    coRetrievedIds
      .filter(otherId => otherId !== id)
      .flatMap(otherId => [
        edgesDb.reinforceEdge(id, otherId, config.reinforcementDelta, currentTurn),
        edgesDb.reinforceEdge(otherId, id, config.reinforcementDelta, currentTurn),
      ]),
  );
}

export async function findMemoryBySnapshot(snapshotName: string): Promise<ReturnType<typeof getMemoryById> | null> {
  const mem = await memoriesDb.getMemoryBySnapshot(snapshotName);
  if (!mem) return null;
  return getMemoryById(mem.id);
}

export async function listMemories(options?: {
  contentType?: AddMemoryOptions['contentType'];
  projectPath?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  id: string; snapshotName: string; title: string; summary: string | null;
  contentType: string; rank: number; retrievalCount: number; tokenCount: number; createdAt: string;
}[]> {
  const mems = await memoriesDb.listMemories({
    contentType: options?.contentType as ContentType,
    projectPath: options?.projectPath,
    limit: options?.limit ?? 50,
    offset: options?.offset ?? 0,
  });
  return mems.map(m => ({
    id: m.id, snapshotName: m.snapshot_name, title: m.title, summary: m.summary,
    contentType: m.content_type, rank: m.rank, retrievalCount: m.retrieval_count,
    tokenCount: m.token_count, createdAt: m.created_at,
  }));
}
