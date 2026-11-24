import * as fs from 'node:fs/promises';
import { PATHS } from '../store/paths.js';

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function readDaemonPid(): Promise<number | null> {
  try {
    const str = await fs.readFile(PATHS.daemonPid, 'utf-8');
    const pid = parseInt(str.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}
