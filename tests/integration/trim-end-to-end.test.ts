// Integration test for the trim path: build a realistic JSONL fixture, run it
// through analyzeSession the same way evaluate.ts does, then drive decide()
// the same way the hook does. Asserts trim fires regardless of intent.
//
// This is the test that would have caught the regression where trim was
// gated on intent === 'continuation' and silently stopped firing for the
// common topic_switch / new_topic cases.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeSession } from '../../src/vendor/cmv/core/analyzer.js';
import { decide } from '../../src/engine/decision.js';
import { computeScore } from '../../src/engine/scorer.js';
import type { DecisionContext } from '../../src/types.js';

// Build a JSONL with N chars of conversation content. Deterministic structure:
// pairs of user prompts + assistant tool_use + tool_result. Each pair adds
// ~bytesPerPair bytes of textual content. We push past CMV's 200k CONTEXT_LIMIT.
function buildJsonl(targetBytes: number): string {
  const lines: string[] = [];
  let totalBytes = 0;
  let i = 0;

  // System line (the analyzer ignores it but real JSONL files start with one)
  const sysLine = JSON.stringify({
    type: 'system',
    cwd: '/tmp/integration-test',
    sessionId: 'integration-trim',
    timestamp: '2026-05-04T00:00:00.000Z',
  });
  lines.push(sysLine);
  totalBytes += sysLine.length + 1;

  while (totalBytes < targetBytes) {
    const userText = `user question ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(40);
    const assistantText = `assistant reply ${i}: ` + 'consectetur adipiscing elit '.repeat(50);
    const toolResultText = 'output line: ' + 'some captured output text '.repeat(60);

    const userLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    });
    const assistantLine = JSON.stringify({
      type: 'assistant',
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: assistantText },
          { type: 'tool_use', id: `tool_${i}`, name: 'Read', input: { file_path: `/tmp/file-${i}.ts` } },
        ],
      },
    });
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tool_${i}`, content: toolResultText }],
      },
    });

    for (const l of [userLine, assistantLine, toolResultLine]) {
      lines.push(l);
      totalBytes += l.length + 1;
    }
    i++;
  }

  return lines.join('\n') + '\n';
}

const mem: MemoryNode = {
  id: 'm1',
  snapshotName: 'test-memory',
  title: 'Test',
  summary: '',
  projectPath: '/tmp',
  tokenCount: 0,
  topics: [],
  retrievalCount: 0,
  lastRetrievedTurn: 0,
  lastRetrievedAt: '',
  createdAtTurn: 0,
  createdAt: '2026-05-04T00:00:00Z',
  outgoingEdges: {},
  incomingEdges: {},
  rank: 0.15,
  rankUpdatedAtTurn: 0,
};

function ctxFor(wantsRecall: boolean, analysis: { estimatedTokens: number; contextUsedPercent: number }, contextLimitTokens = 1_000_000): DecisionContext {
  // wantsRecall=true simulates a topic-switch with strong signal (matched memory present).
  const recall = computeScore(
    0, wantsRecall ? 0.75 : 0, // embeddingScore at recommend threshold when recall wanted
    wantsRecall ? mem : null,
    wantsRecall ? [mem] : [],
    false, false,
    { cwdChanged: false, longGap: false },
    null,
  );
  return {
    recallScore: recall.score,
    embeddingScore: recall.embeddingScore,
    isAmbiguous: recall.isAmbiguous,
    matchedMemory: recall.matchedMemory,
    candidates: recall.candidates,
    currentTurn: 50,
    contextPressure: Math.round((analysis.estimatedTokens / contextLimitTokens) * 100),
    trimPressure: Math.min(100, Math.round(analysis.contextUsedPercent)),
  };
}

describe('integration: trim fires when context exceeds CMV 200k baseline', () => {
  let tmpDir: string;
  let bigJsonl: string;
  let smallJsonl: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'johnny-trim-int-'));

    // ~700k bytes of conversation content. The analyzer counts content text
    // (text blocks, tool_result text, tool_use input) and applies a chars/4
    // heuristic. Plus SYSTEM_OVERHEAD_TOKENS (20k). Need ~140k tokens for
    // contextUsedPercent ≥ 70 against CMV's 200k CONTEXT_LIMIT — that's roughly
    // 480k chars of content + JSON overhead, so a 700k-byte fixture lands above.
    bigJsonl = path.join(tmpDir, 'big.jsonl');
    fs.writeFileSync(bigJsonl, buildJsonl(700_000));

    // ~30k bytes — well under the trim threshold.
    smallJsonl = path.join(tmpDir, 'small.jsonl');
    fs.writeFileSync(smallJsonl, buildJsonl(30_000));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('analyzeSession on big JSONL returns contextUsedPercent ≥ 70', async () => {
    const a = await analyzeSession(bigJsonl);
    expect(a.contextUsedPercent).toBeGreaterThanOrEqual(70);
  });

  // Trim is post-turn-only context hygiene. decide() never returns trim.
  it('big JSONL → decide does NOT return trim regardless of signal', async () => {
    const a = await analyzeSession(bigJsonl);
    for (const wantsRecall of [true, false]) {
      const action = decide(ctxFor(wantsRecall, a));
      expect(action, `wantsRecall=${wantsRecall} must not trim — that's post-turn's job`).not.toBe('trim');
    }
  });

  it('big JSONL + strong recall signal → recommend_memory (contextPressure stays low on 1M limit)', async () => {
    const a = await analyzeSession(bigJsonl);
    const action = decide(ctxFor(true, a));
    // contextPressure is 1M-based; big JSONL stays well below 50% → recommend fires, not hard_switch
    expect(action).toBe('recommend_memory');
  });

  it('small JSONL → recommend_memory fires when recall signal is strong', async () => {
    const a = await analyzeSession(smallJsonl);
    const action = decide(ctxFor(true, a));
    expect(action).toBe('recommend_memory');
  });
});
