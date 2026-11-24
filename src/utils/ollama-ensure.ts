// Ensure Ollama is running before LLM calls that can't silently skip.
// Attempts to start the Ollama server if it's offline, polls for up to 10s.
import { spawn } from 'node:child_process';
import { isOllamaOnline } from './llm.js';
import { log } from './log.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function ensureOllama(): Promise<boolean> {
  if (await isOllamaOnline()) return true;

  await log('ollama-ensure: offline — attempting to start');
  try {
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    await log('ollama-ensure: could not spawn ollama serve');
    return false;
  }

  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isOllamaOnline()) {
      await log('ollama-ensure: online');
      return true;
    }
  }

  await log('ollama-ensure: timed out after 10s');
  return false;
}
