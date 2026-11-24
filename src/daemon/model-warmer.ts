// Keeps Ollama models loaded between hook calls by sending lightweight keep-alive requests.
import { embed, classify, isOllamaOnline, WARM_TIMEOUT_MS } from '../utils/llm.js';
import { log } from '../utils/log.js';
import { recordHeartbeat } from '../store/db/heartbeats.js';

const WARM_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (Ollama unloads at 5m)
const CHECK_INTERVAL_MS = 30_000;        // probe online every 30s

let warmTimer: ReturnType<typeof setTimeout> | null = null;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let ollamaOnline = false;

async function warmModels(): Promise<void> {
  if (!ollamaOnline) return;
  // Independent try/catches: these used to be one sequential try block, so a
  // classify() timeout (qwen2.5:3b — a 3B model, much slower to cold-load on
  // CPU than the embedder) meant embed()'s already-successful warm never got
  // logged as such and, worse, every retry stayed serialized behind the slow
  // one. Warming with WARM_TIMEOUT_MS (not the interactive hook's tight
  // budget) gives a cold model a real chance to finish loading instead of
  // aborting and leaving it to fall out of Ollama's 5-minute idle unload —
  // that's what was showing up as qwen missing from the doctor dashboard's
  // OLLAMA panel (which reflects /api/ps — currently *loaded* models, not
  // installed ones).
  const results = await Promise.allSettled([
    embed('johnny warm', WARM_TIMEOUT_MS),
    classify('warm', '', WARM_TIMEOUT_MS),
  ]);
  const [embedResult, classifyResult] = results;
  if (embedResult.status === 'rejected') {
    await log(`model-warmer: embed warm failed — ${embedResult.reason}`);
  }
  if (classifyResult.status === 'rejected') {
    await log(`model-warmer: classify warm failed — ${classifyResult.reason}`);
  }
  if (embedResult.status === 'fulfilled' && classifyResult.status === 'fulfilled') {
    await log('model-warmer: models warmed');
  }
}

async function checkOnline(): Promise<void> {
  const prev = ollamaOnline;
  ollamaOnline = await isOllamaOnline();
  // Heartbeat fires on every check tick — proves the subsystem is alive.
  // didWork=true only when ollama was online so we performed a real probe.
  try {
    recordHeartbeat('model-warmer', {
      didWork: ollamaOnline,
      status: ollamaOnline ? 'ok' : 'stalled',
    });
  } catch { /* best-effort */ }
  if (ollamaOnline && !prev) {
    await log('model-warmer: Ollama came online — warming immediately');
    await warmModels();
  }
}

export function startModelWarmer(): void {
  const warmTick = async () => {
    try { await warmModels(); } catch { /* swallow */ }
    warmTimer = setTimeout(warmTick, WARM_INTERVAL_MS);
  };

  const checkTick = async () => {
    try { await checkOnline(); } catch { /* swallow */ }
    checkTimer = setTimeout(checkTick, CHECK_INTERVAL_MS);
  };

  // Check immediately, then start warm loop
  checkTick();
  warmTimer = setTimeout(warmTick, WARM_INTERVAL_MS);
}

export function stopModelWarmer(): void {
  if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
}
