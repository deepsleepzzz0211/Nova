import { defineConfig } from 'vitest/config';

/**
 * Config for SMOKE tests: full pipeline against a REAL LLM endpoint.
 * Run explicitly: pnpm test:smoke
 * Requires NOVA_SMOKE_API_KEY (and optionally TAVILY_API_KEY for web_search).
 */
export default defineConfig({
  test: {
    include: ['tests/smoke/**/*.test.ts'],
    reporters: 'verbose',
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
