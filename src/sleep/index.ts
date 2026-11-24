// Sleep-phase consolidation — runs on idle trigger from daemon.
import { discoverLatentEdges as _discoverLatentEdges } from './latent-edges.js';
import { discoverSkillCandidates } from './skill-discovery.js';
import { extractSchemas } from './schema-extraction.js';
import { rescaleAndPrune } from './homeostasis.js';
import { readGraphFull } from '../store/graph.js';
import { readConfig } from '../store/config.js';
import { getTurnCounter } from '../store/db/state.js';
import { getMemoryCount } from '../store/db/memories.js';

export interface ConsolidationReport {
  schemasCreated: number;
  latentEdgesAdded: number;
  edgesPruned: number;
  memoriesArchived: number;
  memoriesResummarized: number;
  skillCandidatesFound: number;
  turnAtConsolidation: number;
  durationMs: number;
  rescaleApplied: boolean;
}

export async function runConsolidation(): Promise<ConsolidationReport | null> {
  const started = Date.now();

  const totalMemories = await getMemoryCount();
  if (totalMemories < 2) {
    console.error('[sleep] nothing to consolidate');
    return null;
  }

  console.error(`[sleep] consolidating ${totalMemories} memories`);

  const [graph, config, currentTurn] = await Promise.all([
    readGraphFull(),
    readConfig(),
    getTurnCounter(),
  ]);

  const { latentEdgesAdded } = await _discoverLatentEdges(graph, config, currentTurn);
  const { skillCandidatesFound } = await discoverSkillCandidates(config, currentTurn);
  const { schemasCreated } = await extractSchemas(graph, config, currentTurn);
  const homeostasis = await rescaleAndPrune(graph, config, currentTurn);

  const durationMs = Date.now() - started;
  return {
    schemasCreated, latentEdgesAdded,
    edgesPruned: homeostasis.edgesPruned,
    memoriesArchived: homeostasis.memoriesArchived, memoriesResummarized: 0, skillCandidatesFound,
    turnAtConsolidation: currentTurn, durationMs, rescaleApplied: homeostasis.rescaleApplied,
  };
}

export { rescaleAndPrune } from './homeostasis.js';
