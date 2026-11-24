import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../src/vendor/cmv/core/analyzer.js', () => ({
  analyzeSession: vi.fn(async () => ({ estimatedTokens: 100, contextUsedPercent: 10 } as any)),
}));

import { analyzeSession as cachedAnalyzeSession } from '../../src/utils/analysis-cache.js';
import { analyzeSession as rawAnalyzeSession } from '../../src/vendor/cmv/core/analyzer.js';

describe('utils/analysis-cache', () => {
  let file: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    file = path.join(os.tmpdir(), `analysis-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    await fsp.writeFile(file, '{"a":1}\n');
  });

  afterEach(async () => {
    await fsp.rm(file, { force: true });
  });

  it('reuses the cached result when the file is unchanged (mtime+size hit)', async () => {
    const a = await cachedAnalyzeSession(file);
    const b = await cachedAnalyzeSession(file);
    expect(rawAnalyzeSession).toHaveBeenCalledTimes(1);
    expect(b).toBe(a); // same cached object, not just equal
  });

  it('re-analyzes once the file has been appended to (size changes)', async () => {
    await cachedAnalyzeSession(file);
    await fsp.appendFile(file, '{"a":2}\n');
    await cachedAnalyzeSession(file);
    expect(rawAnalyzeSession).toHaveBeenCalledTimes(2);
  });

  it('keeps independent cache entries per file path', async () => {
    const file2 = `${file}.2`;
    await fsp.writeFile(file2, '{"b":1}\n');
    try {
      await cachedAnalyzeSession(file);
      await cachedAnalyzeSession(file2);
      expect(rawAnalyzeSession).toHaveBeenCalledTimes(2);
    } finally {
      await fsp.rm(file2, { force: true });
    }
  });
});
