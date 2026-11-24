import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function readJsonlLines(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

export async function writeJsonlLines(filePath: string, lines: unknown[]): Promise<void> {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  await fs.writeFile(filePath, content, 'utf-8');
}

// Atomic write: write to tmp then rename over target (same pattern as CMV auto-trim)
export async function atomicWriteJsonl(targetPath: string, lines: unknown[]): Promise<void> {
  const tmp = targetPath + '.johnny.tmp';
  try {
    await writeJsonlLines(tmp, lines);
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
