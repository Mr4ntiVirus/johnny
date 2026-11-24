import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as memoriesDb from '../store/db/memories.js';
import * as transcriptsDb from '../store/db/transcripts.js';
import { slugify, extractTopics } from '../utils/slugify.js';

interface SkillInfo {
  name: string;
  description: string;
  instructions: string;
  commands: string[];
  filePath: string;
}

interface ToolInfo {
  name: string;
  description: string;
  schema: string;
  category: string;
  filePath: string;
}

function findSkills(dir: string, prefix = ''): SkillInfo[] {
  const skills: SkillInfo[] = [];
  if (!fs.existsSync(dir)) return skills;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      skills.push(...findSkills(fullPath, name));
    } else if (entry.name === 'skill.md' || entry.name === 'README.md') {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const commands = fs.readdirSync(path.dirname(fullPath))
        .filter(f => f.endsWith('.md') && f !== 'skill.md' && f !== 'README.md')
        .map(f => f.replace('.md', ''));
      skills.push({ name, description: content.split('\n')[0].replace(/^#+\s*/, ''), instructions: content, commands, filePath: fullPath });
    }
  }
  return skills;
}

function findTools(dir: string): ToolInfo[] {
  const tools: ToolInfo[] = [];
  if (!fs.existsSync(dir)) return tools;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const fullPath = path.join(dir, entry.name);
      const configPath = path.join(fullPath, 'tool.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          tools.push({ name: entry.name, description: config.description || entry.name, schema: JSON.stringify(config.commands || {}), category: config.category || 'general', filePath: fullPath });
        } catch { /* skip */ }
      }
    }
  }
  return tools;
}

export async function bootstrapSkills(): Promise<{ skills: number; tools: number }> {
  const homeDir = os.homedir();
  const results = { skills: 0, tools: 0 };
  const skillDirs = [path.join(homeDir, '.claude', 'skills')];
  for (const dir of skillDirs) {
    for (const skill of findSkills(dir)) {
      const snapshotName = `skill-${slugify(skill.name)}`;
      if (await memoriesDb.getMemoryBySnapshot(snapshotName)) continue;
      const topics = extractTopics(skill.instructions);
      const tokenCount = Math.ceil(skill.instructions.split(/\s+/).length * 1.3);
      const id = await memoriesDb.createMemory({ snapshotName, title: skill.name, summary: skill.description, contentType: 'skill', projectPath: skill.filePath, tokenCount, createdAtTurn: 0 });
      await transcriptsDb.createTranscript({ memoryId: id, transcript: skill.instructions, topics, skillName: skill.name, skillCommands: skill.commands, skillInstructions: skill.instructions });
      results.skills++;
    }
  }
  const toolDirs: string[] = []; // tool bundles were an OpenCode concept; none are scanned for Claude Code
  for (const dir of toolDirs) {
    for (const tool of findTools(dir)) {
      const snapshotName = `tool-${slugify(tool.name)}`;
      if (await memoriesDb.getMemoryBySnapshot(snapshotName)) continue;
      const topics = extractTopics(tool.description);
      const tokenCount = Math.ceil(tool.description.split(/\s+/).length * 1.3);
      const id = await memoriesDb.createMemory({ snapshotName, title: tool.name, summary: tool.description, contentType: 'tool', projectPath: tool.filePath, tokenCount, createdAtTurn: 0 });
      await transcriptsDb.createTranscript({ memoryId: id, transcript: tool.description, topics, toolName: tool.name, toolDescription: tool.description, toolCategory: tool.category, toolSchema: tool.schema });
      results.tools++;
    }
  }
  return results;
}

export async function suggestSkills(prompt: string, limit = 3): Promise<{ name: string; description: string; confidence: number }[]> {
  const skills = await transcriptsDb.getSkills();
  const promptLower = prompt.toLowerCase();
  const promptTokens = new Set(promptLower.split(/[\s\W]+/).filter(t => t.length > 2));
  const mems = await Promise.all(skills.map(s => memoriesDb.getMemory(s.memory_id)));
  return skills.map((skill, i) => {
    let score = 0;
    if (skill.skill_name && promptLower.includes(skill.skill_name.toLowerCase())) score += 10;
    if (skill.topics) {
      for (const topic of JSON.parse(skill.topics) as string[]) {
        if (promptTokens.has(topic.toLowerCase())) score += 1;
      }
    }
    return { name: skill.skill_name ?? 'unknown', description: skill.skill_instructions?.split('\n')[0] ?? '', confidence: score + (mems[i]?.rank ?? 0.15) };
  }).filter(s => s.confidence > 0).sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export async function suggestTools(prompt: string, limit = 3): Promise<{ name: string; description: string; category: string; confidence: number }[]> {
  const tools = await transcriptsDb.getTools();
  const promptLower = prompt.toLowerCase();
  const mems = await Promise.all(tools.map(t => memoriesDb.getMemory(t.memory_id)));
  return tools.map((tool, i) => {
    let score = 0;
    if (tool.tool_name && promptLower.includes(tool.tool_name.toLowerCase())) score += 10;
    if (tool.tool_category && promptLower.includes(tool.tool_category.toLowerCase())) score += 5;
    if (tool.tool_description) for (const token of promptLower.split(/[\s\W]+/)) if (tool.tool_description.toLowerCase().includes(token)) score += 0.5;
    return { name: tool.tool_name ?? 'unknown', description: tool.tool_description ?? '', category: tool.tool_category ?? 'general', confidence: score + (mems[i]?.rank ?? 0.15) };
  }).filter(t => t.confidence > 0).sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}
