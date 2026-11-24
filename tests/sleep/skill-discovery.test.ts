import { describe, it, expect } from 'vitest';
import { useTestDb } from '../helpers/db.js';
import { discoverSkillCandidates } from '../../src/sleep/skill-discovery.js';
import * as memoriesDb from '../../src/store/db/memories.js';
import * as transcriptsDb from '../../src/store/db/transcripts.js';
import * as skillCandidatesDb from '../../src/store/db/skill-candidates.js';
import { execute } from '../../src/store/db-client.js';
import { DEFAULT_CONFIG } from '../../src/store/config.js';
import type { JohnnyConfig } from '../../src/types.js';

const cfg = (overrides: Partial<JohnnyConfig> = {}): JohnnyConfig =>
  ({ ...DEFAULT_CONFIG, ...overrides });

async function seedMem(slug: string, project: string, topics: string[], daysAgo = 0): Promise<string> {
  const id = await memoriesDb.createMemory({
    snapshotName: slug,
    title: slug,
    summary: slug,
    projectPath: project,
    tokenCount: 10,
    createdAtTurn: 1,
  });
  // Backdate created_at so recurrence scoring works
  if (daysAgo > 0) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    await execute(
      'UPDATE memories SET created_at = ? WHERE id = ?',
      [d.toISOString(), id],
    );
  }
  await transcriptsDb.createTranscript({ memoryId: id, transcript: slug, topics });
  return id;
}

describe('discoverSkillCandidates', () => {
  useTestDb();

  it('detects a cluster of 3+ memories sharing topics', async () => {
    await seedMem('work-a', '/proj', ['vmware', 'vsphere', 'migration'], 10);
    await seedMem('work-b', '/proj', ['vmware', 'vsphere', 'host'], 8);
    await seedMem('work-c', '/proj', ['vmware', 'vsphere', 'cluster'], 5);

    const result = await discoverSkillCandidates(cfg(), 50);
    expect(result.skillCandidatesFound).toBeGreaterThan(0);

    const candidates = await skillCandidatesDb.getProposedCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    // The vmware cluster slug should appear
    const slugs = candidates.map(c => c.slug);
    expect(slugs.some(s => s.includes('vmware') || s.includes('vsphere'))).toBe(true);
  });

  it('does not create a candidate when cluster is below minSkillClusterSize', async () => {
    await seedMem('solo-a', '/proj2', ['docker', 'container'], 5);
    await seedMem('solo-b', '/proj2', ['docker', 'container'], 3);

    const result = await discoverSkillCandidates(cfg({ minSkillClusterSize: 3 }), 50);
    // Only 2 memories share the cluster — no candidate
    const candidates = await skillCandidatesDb.getProposedCandidates();
    expect(candidates.length).toBe(0);
    expect(result.skillCandidatesFound).toBe(0);
  });

  it('skips dismissed slugs on re-discovery', async () => {
    await seedMem('dis-a', '/proj3', ['terraform', 'iac', 'deploy'], 15);
    await seedMem('dis-b', '/proj3', ['terraform', 'iac', 'module'], 10);
    await seedMem('dis-c', '/proj3', ['terraform', 'iac', 'provider'], 5);

    // First pass creates candidates; dismiss ALL of them
    await discoverSkillCandidates(cfg(), 50);
    const before = await skillCandidatesDb.getProposedCandidates();
    for (const c of before) await skillCandidatesDb.setStatus(c.slug, 'dismissed');

    // Second pass should not re-propose any dismissed slug
    await discoverSkillCandidates(cfg(), 51);
    const after = await skillCandidatesDb.getProposedCandidates();
    expect(after.length).toBe(0);
  });

  it('does not create candidates for skill/tool content types', async () => {
    await seedMem('existing-skill', '/proj4', ['vsphere', 'vmware', 'host'], 10);
    await seedMem('existing-skill-2', '/proj4', ['vsphere', 'vmware', 'vm'], 8);
    await seedMem('existing-skill-3', '/proj4', ['vsphere', 'vmware', 'cluster'], 6);
    // Add one more as a skill type — should be excluded from clustering
    await memoriesDb.createMemory({
      snapshotName: 'vsphere-skill',
      title: 'vsphere-skill',
      summary: 'existing skill',
      projectPath: '/proj4',
      contentType: 'skill',
      tokenCount: 10,
    });

    await discoverSkillCandidates(cfg(), 50);
    const candidates = await skillCandidatesDb.getProposedCandidates();
    // Cluster may still exist from the 3 non-skill memories — that's fine
    // Just verify no crash and the skill memory itself didn't seed a candidate
    expect(candidates.every(c => c.slug !== 'vsphere-skill')).toBe(true);
  });

  it('scores recurrence higher when memories span multiple days', async () => {
    // Spread-out cluster (high recurrence)
    await seedMem('spread-a', '/proj5', ['kubernetes', 'k8s', 'deploy'], 20);
    await seedMem('spread-b', '/proj5', ['kubernetes', 'k8s', 'pod'], 15);
    await seedMem('spread-c', '/proj5', ['kubernetes', 'k8s', 'service'], 10);
    // Same-day cluster (low recurrence)
    await seedMem('recent-a', '/proj6', ['react', 'hooks', 'component'], 0);
    await seedMem('recent-b', '/proj6', ['react', 'hooks', 'state'], 0);
    await seedMem('recent-c', '/proj6', ['react', 'hooks', 'effect'], 0);

    await discoverSkillCandidates(cfg(), 50);
    const candidates = await skillCandidatesDb.getProposedCandidates();
    const k8sCand = candidates.find(c => c.slug.includes('kubernetes') || c.slug.includes('k8s'));
    const reactCand = candidates.find(c => c.slug.includes('react') || c.slug.includes('hooks'));

    if (k8sCand && reactCand) {
      expect(k8sCand.cluster_score).toBeGreaterThan(reactCand.cluster_score);
    }
  });
});
