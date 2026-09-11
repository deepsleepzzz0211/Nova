import { defineConfig } from 'vitest/config';

/**
 * Deterministic TUI E2E: real PTY, no LLM calls, no API key. Runs in CI on
 * every PR (ubuntu + windows). Requires a build (`pnpm build`) because the
 * suite drives dist/index.js.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/tui/tui-deterministic.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
