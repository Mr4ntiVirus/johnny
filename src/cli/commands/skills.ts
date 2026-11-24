// Praxis CLI — browse, approve, or dismiss skill candidates.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as skillCandidatesDb from '../../store/db/skill-candidates.js';
import * as memoriesDb from '../../store/db/memories.js';
import * as transcriptsDb from '../../store/db/transcripts.js';
import * as edgesDb from '../../store/db/edges.js';
import { getTurnCounter } from '../../store/db/state.js';
import { neon, ink, dim } from '../../brand/tokens.js';

const w = (s: string) => process.stdout.write(s);

export async function cmdSkillsProposed(): Promise<void> {
  const candidates = await skillCandidatesDb.getProposedCandidates();
  if (candidates.length === 0) { w(dim.fg('No proposed skills yet. Run `johnny sleep` to discover candidates.\n')); return; }
  w(neon.cyan(`Proposed skills (${candidates.length}):\n`));
  for (const c of candidates) {
    const topics: string[] = JSON.parse(c.topics);
    const sourceIds: string[] = JSON.parse(c.source_memory_ids);
    const pct = Math.round(c.cluster_score * 100);
    w(`  ${ink.fg(c.slug.padEnd(32))}${dim.fg(`(score: ${pct}%)`).padEnd(18)}${dim.fg(`${sourceIds.length} source memories`).padEnd(22)}· topics: ${topics.slice(0, 5).join(', ')}\n`);
  }
  w(dim.fg('\n  Approve: johnny skills approve <slug>\n'));
  w(dim.fg('  Dismiss: johnny skills dismiss <slug>\n'));
}

export async function cmdSkillsDismiss(slug: string): Promise<void> {
  const cand = await skillCandidatesDb.getCandidateBySlug(slug);
  if (!cand) { process.stderr.write(`No candidate named "${slug}".\n`); process.exit(1); }
  await skillCandidatesDb.setStatus(slug, 'dismissed');
  w(dim.fg(`Dismissed "${slug}".\n`));
}

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function buildSkillMarkdown(slug: string, topics: string[], sourceSummaries: string[], clusterScore: number, sourceMemoryIds: string[]): string {
  const topicsLine = topics.slice(0, 8).join(', ');
  const summaryBlock = sourceSummaries.slice(0, 5).map(s => `- ${s.slice(0, 120).replace(/\n/g, ' ')}`).join('\n');
  return [`---`, `description: "Praxis skill — ${topicsLine}. Crystallized from ${sourceMemoryIds.length} memories."`,
    `johnny:`, `  sourceMemoryIds: ${JSON.stringify(sourceMemoryIds)}`,
    `  discoveredAt: "${new Date().toISOString().slice(0, 10)}"`, `  clusterScore: ${clusterScore.toFixed(3)}`,
    `---`, ``, `# ${slug}`, ``, `Crystallized from ${sourceMemoryIds.length} memories covering: ${topicsLine}.`,
    ``, `## Summary`, ``, summaryBlock || '*(no summaries available)*', ``, `## Common patterns observed`, ``,
    `*(Fill this in based on your experience with ${topicsLine}.)*`, ``].join('\n');
}

export async function cmdSkillsApprove(slug: string): Promise<void> {
  const cand = await skillCandidatesDb.getCandidateBySlug(slug);
  if (!cand) { process.stderr.write(`No candidate named "${slug}".\n`); process.exit(1); }
  if (cand.status === 'approved') { w(dim.fg(`"${slug}" is already approved.\n`)); return; }

  const topics: string[] = JSON.parse(cand.topics);
  const sourceMemoryIds: string[] = JSON.parse(cand.source_memory_ids);

  const sourceSummaries: string[] = [];
  for (const id of sourceMemoryIds) {
    const m = await memoriesDb.getMemory(id);
    if (m?.summary) sourceSummaries.push(m.summary);
  }

  const skillDir = path.join(SKILLS_DIR, slug);
  const skillFile = path.join(skillDir, 'skill.md');
  await fs.mkdir(skillDir, { recursive: true });

  let existingFile = false;
  try { await fs.access(skillFile); existingFile = true; } catch { /* ok */ }

  if (!existingFile) {
    await fs.writeFile(skillFile, buildSkillMarkdown(slug, topics, sourceSummaries, cand.cluster_score, sourceMemoryIds), 'utf-8');
    w(neon.cyan('◈') + ink.fg(` skill file created · ${skillFile}\n`));
  } else {
    w(dim.fg(`  skill file already exists · ${skillFile}\n`));
  }

  const currentTurn = await getTurnCounter();
  const existingMem = await memoriesDb.getMemoryBySnapshot(slug);
  let skillMemId: string;

  if (existingMem) {
    skillMemId = existingMem.id;
    w(dim.fg(`  skill memory already exists: ${slug}\n`));
  } else {
    const summary = `Praxis skill from ${sourceMemoryIds.length} memories: ${topics.slice(0, 5).join(', ')}`;
    skillMemId = await memoriesDb.createMemory({ id: randomUUID(), snapshotName: slug, title: slug, summary, contentType: 'skill', projectPath: SKILLS_DIR, tokenCount: sourceSummaries.join(' ').split(/\s+/).length, createdAtTurn: currentTurn });
    await transcriptsDb.createTranscript({ memoryId: skillMemId, transcript: sourceSummaries.join('\n\n---\n\n'), topics, skillName: slug, skillInstructions: skillFile, skillCommands: topics });
    w(neon.cyan('◈') + ink.fg(` skill memory node created · ${slug}\n`));
  }

  let edgesCreated = 0;
  for (const sourceMemId of sourceMemoryIds) {
    if (!(await memoriesDb.getMemory(sourceMemId))) continue;
    try { await edgesDb.createEdge({ sourceId: sourceMemId, targetId: skillMemId, edgeType: 'skill_link', weight: 1.0, createdAtTurn: currentTurn }); edgesCreated++; } catch { /* UNIQUE */ }
  }
  w(dim.fg(`  ${edgesCreated} emergence edge(s) wired\n`));

  if (!existingFile) {
    const existing = await fs.readFile(skillFile, 'utf-8');
    await fs.writeFile(skillFile, existing.replace(/^(johnny:)/m, `$1\n  memoryId: "${skillMemId}"`), 'utf-8');
  }

  await skillCandidatesDb.setStatus(slug, 'approved');
  w(neon.cyan('✓') + ink.fg(` "${slug}" approved · `) + dim.fg('use it with /') + neon.cyan(slug) + dim.fg(' in Claude Code\n'));
}

export async function reconcileFromSkillFiles(skillsDir: string): Promise<number> {
  let reconciled = 0;
  let entries: string[];
  try { entries = await fs.readdir(skillsDir); } catch { return 0; }

  const currentTurn = await getTurnCounter();

  for (const entry of entries) {
    const skillFile = path.join(skillsDir, entry, 'skill.md');
    try { await fs.access(skillFile); } catch { continue; }

    const content = await fs.readFile(skillFile, 'utf-8');
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) continue;
    const sourceIdsMatch = frontmatterMatch[1].match(/sourceMemoryIds:\s*(\[.*?\])/);
    if (!sourceIdsMatch) continue;

    let sourceMemoryIds: string[];
    try { sourceMemoryIds = JSON.parse(sourceIdsMatch[1]); } catch { continue; }

    const slug = entry;
    if (await memoriesDb.getMemoryBySnapshot(slug)) continue;

    const summary = `Praxis skill (reconciled): ${slug}`;
    const skillMemId = await memoriesDb.createMemory({ id: randomUUID(), snapshotName: slug, title: slug, summary, contentType: 'skill', projectPath: skillsDir, tokenCount: 10, createdAtTurn: currentTurn });
    await transcriptsDb.createTranscript({ memoryId: skillMemId, transcript: summary, topics: [slug], skillName: slug, skillInstructions: skillFile });

    for (const srcId of sourceMemoryIds) {
      if (!(await memoriesDb.getMemory(srcId))) continue;
      try { await edgesDb.createEdge({ sourceId: srcId, targetId: skillMemId, edgeType: 'skill_link', weight: 1.0, createdAtTurn: currentTurn }); } catch { /* UNIQUE */ }
    }
    reconciled++;
  }
  return reconciled;
}

export async function cmdSkills(args: string[]): Promise<void> {
  const sub = args[0] ?? 'proposed';
  switch (sub) {
    case 'proposed': case 'list': await cmdSkillsProposed(); break;
    case 'dismiss':
      if (!args[1]) { process.stderr.write('Usage: johnny skills dismiss <slug>\n'); process.exit(1); }
      await cmdSkillsDismiss(args[1]); break;
    case 'approve':
      if (!args[1]) { process.stderr.write('Usage: johnny skills approve <slug>\n'); process.exit(1); }
      await cmdSkillsApprove(args[1]); break;
    default:
      process.stderr.write(`Unknown subcommand "${sub}". Try: proposed | approve | dismiss\n`);
      process.exit(1);
  }
}
