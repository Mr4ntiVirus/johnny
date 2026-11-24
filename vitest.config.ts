import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      // Deterministic stub responses instead of calling Ollama.
      JOHNNY_LLM_MOCK: '1',
    },
  },
});
