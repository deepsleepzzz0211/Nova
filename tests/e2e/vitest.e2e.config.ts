import { defineConfig } from 'vitest/config';

/**
 * E2E suite: drives the BUILT binary (dist/index.js) as a real subprocess
 * against a real LLM endpoint. Requires a build (`pnpm build`) and an API
 * key in the environment:
 *
 *   WEIXIN_API_KEY=... pnpm test:e2e
 *
 * Without a key every test skips with an explicit message (never silently
 * passes). Rate-limited runs retry once, then skip with the provider's
 * message so free-tier quotas do not produce false failures.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Real network + real child processes: keep the suite serial.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
