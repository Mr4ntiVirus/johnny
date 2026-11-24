import { query, queryOne, execute } from '../db-client.js';
import { randomUUID } from 'node:crypto';

export type SkillCandidateStatus = 'proposed' | 'approved' | 'dismissed';

export interface SkillCandidateRecord {
  id: string;
  slug: string;
  topics: string;
  source_memory_ids: string;
  cluster_score: number;
  discovery_turn: number | null;
  status: SkillCandidateStatus;
  created_at: string;
}

export interface SkillCandidateInput {
  slug: string;
  topics: string[];
  sourceMemoryIds: string[];
  clusterScore: number;
  discoveryTurn: number;
}

export async function upsertSkillCandidate(input: SkillCandidateInput): Promise<void> {
  const existing = await queryOne<{ id: string; status: string }>(
    'SELECT id, status FROM skill_candidates WHERE slug = ?',
    [input.slug],
  );

  if (existing && (existing.status === 'approved' || existing.status === 'dismissed')) return;

  if (existing) {
    await execute(
      `UPDATE skill_candidates
       SET topics = ?, source_memory_ids = ?, cluster_score = ?, discovery_turn = ?
       WHERE slug = ?`,
      [JSON.stringify(input.topics), JSON.stringify(input.sourceMemoryIds), input.clusterScore, input.discoveryTurn, input.slug],
    );
  } else {
    await execute(
      `INSERT INTO skill_candidates (id, slug, topics, source_memory_ids, cluster_score, discovery_turn, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      [randomUUID(), input.slug, JSON.stringify(input.topics), JSON.stringify(input.sourceMemoryIds), input.clusterScore, input.discoveryTurn, new Date().toISOString()],
    );
  }
}

export async function getProposedCandidates(): Promise<SkillCandidateRecord[]> {
  return query<SkillCandidateRecord>(
    `SELECT * FROM skill_candidates WHERE status = 'proposed' ORDER BY cluster_score DESC`,
  );
}

export async function getCandidateBySlug(slug: string): Promise<SkillCandidateRecord | null> {
  return queryOne<SkillCandidateRecord>('SELECT * FROM skill_candidates WHERE slug = ?', [slug]);
}

export async function setStatus(slug: string, status: SkillCandidateStatus): Promise<void> {
  await execute('UPDATE skill_candidates SET status = ? WHERE slug = ?', [status, slug]);
}

export async function isDismissed(slug: string): Promise<boolean> {
  const row = await queryOne<{ status: string }>(
    `SELECT status FROM skill_candidates WHERE slug = ?`,
    [slug],
  );
  return row?.status === 'dismissed';
}
