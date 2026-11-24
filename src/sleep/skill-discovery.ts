// Praxis Phase 1 — discover candidate skills from repeated memory patterns.
//
// Algorithm: for each project, build a topic inverted index, find topic
// clusters (≥minSkillClusterSize memories sharing ≥2 topics), score them by
// cohesion × recurrence × density, and write candidates above
// minSkillClusterScore to the skill_candidates table.
//
// Pure heuristic — no LLM needed. Claude approves the winners via
// `johnny skills approve <slug>`.

import * as memoriesDb from '../store/db/memories.js';
import * as transcriptsDb from '../store/db/transcripts.js';
import * as skillCandidatesDb from '../store/db/skill-candidates.js';
import { log } from '../utils/log.js';
import type { JohnnyConfig } from '../types.js';

export interface SkillCandidateResult {
  skillCandidatesFound: number;
}

// Collapse a topic to a slug safe for use as a skill name.
function topicToSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Compute span of memory creation dates in days.
function daySpan(dates: string[]): number {
  if (dates.length < 2) return 0;
  const ms = dates.map(d => new Date(d).getTime()).filter(n => !isNaN(n));
  if (ms.length < 2) return 0;
  return (Math.max(...ms) - Math.min(...ms)) / 86_400_000;
}

export async function discoverSkillCandidates(
  config: JohnnyConfig,
  currentTurn: number,
): Promise<SkillCandidateResult> {
  const minSize  = config.minSkillClusterSize;
  const minScore = config.minSkillClusterScore;

  // Load all non-skill memories with their topics and project paths.
  const [allMemories, topicsByMem] = await Promise.all([
    memoriesDb.listMemories({ limit: 2000 }),
    transcriptsDb.getAllTopicsByMemory(),
  ]);

  // Group by projectPath, filtering out existing skill/tool memories.
  type MemInfo = { id: string; projectPath: string; createdAt: string; topics: string[] };
  const byProject = new Map<string, MemInfo[]>();
  for (const m of allMemories) {
    if (m.content_type === 'skill' || m.content_type === 'tool') continue;
    const proj = m.project_path ?? '__global__';
    const topics = topicsByMem.get(m.id) ?? [];
    if (topics.length === 0) continue;
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj)!.push({ id: m.id, projectPath: proj, createdAt: m.created_at, topics });
  }

  let skillCandidatesFound = 0;

  for (const [, mems] of byProject) {
    if (mems.length < minSize) continue;

    // Build inverted index: topic → Set of memory IDs.
    const topicIndex = new Map<string, Set<string>>();
    for (const m of mems) {
      for (const t of m.topics) {
        if (!topicIndex.has(t)) topicIndex.set(t, new Set());
        topicIndex.get(t)!.add(m.id);
      }
    }

    // Find topic pairs that share ≥ minSize memories — those are the cluster seeds.
    const topics = Array.from(topicIndex.keys());
    const seen = new Set<string>(); // dedupe candidate slugs within this project

    for (let i = 0; i < topics.length; i++) {
      const topicA = topics[i];
      const setA = topicIndex.get(topicA)!;
      if (setA.size < minSize) continue;

      // Build the cluster: all memories sharing topicA plus their co-topics.
      const clusterMemIds = Array.from(setA);
      const clusterMems = clusterMemIds.map(id => mems.find(m => m.id === id)!).filter(Boolean);

      // Collect secondary topics (topics shared by ≥2 cluster members).
      const secondaryCount = new Map<string, number>();
      for (const m of clusterMems) {
        for (const t of m.topics) {
          if (t === topicA) continue;
          secondaryCount.set(t, (secondaryCount.get(t) ?? 0) + 1);
        }
      }
      const coreTopics = [topicA, ...Array.from(secondaryCount.entries())
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t)
        .slice(0, 6)];

      // Candidate slug = first topic (most distinctive).
      const slug = topicToSlug(topicA);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Skip if already dismissed.
      if (await skillCandidatesDb.isDismissed(slug)) continue;

      // Score the cluster.
      const cohesion = clusterMems.length / mems.length;
      const span = daySpan(clusterMems.map(m => m.createdAt));
      const recurrence = span >= 7 ? 1.0 : span >= 1 ? 0.5 : 0.2;

      // Density: average fraction of core topics shared per memory pair.
      let pairShared = 0;
      let pairCount = 0;
      for (let p = 0; p < clusterMems.length; p++) {
        for (let q = p + 1; q < clusterMems.length; q++) {
          const setP = new Set(clusterMems[p].topics);
          const shared = clusterMems[q].topics.filter(t => setP.has(t)).length;
          pairShared += shared / Math.max(coreTopics.length, 1);
          pairCount++;
        }
      }
      const density = pairCount > 0 ? pairShared / pairCount : 0;

      const clusterScore = cohesion * recurrence * density;

      if (clusterScore < minScore || clusterMems.length < minSize) continue;

      await skillCandidatesDb.upsertSkillCandidate({
        slug,
        topics: coreTopics,
        sourceMemoryIds: clusterMemIds,
        clusterScore,
        discoveryTurn: currentTurn,
      });
      skillCandidatesFound++;
    }
  }

  if (skillCandidatesFound > 0) {
    await log(`sleep/skill-discovery: ${skillCandidatesFound} candidate(s) found`);
  }

  return { skillCandidatesFound };
}
