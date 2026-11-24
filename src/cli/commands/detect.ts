import * as cp from 'node:child_process';

export interface CodingAssistant {
  id: string;
  name: string;
  available: boolean;
  binary?: string;
}

export async function detectClaude(): Promise<CodingAssistant> {
  const assistant: CodingAssistant = {
    id: 'claude',
    name: 'Claude Code',
    available: false,
    binary: 'claude',
  };

  try {
    cp.execSync('command -v claude', { stdio: 'ignore' });
    assistant.available = true;
  } catch {
    assistant.available = false;
  }

  return assistant;
}

export async function detectAll(): Promise<CodingAssistant[]> {
  const claude = await detectClaude();
  return [claude].filter(a => a.available);
}
