import { defineConfig } from 'vitest/config';

/**
 * Config for LIVE network tests (real HTTP calls, no mocks).
 * Run explicitly: npx vitest run --config tests/live/vitest.live.config.ts
 * Excluded from the default `pnpm test` suite.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    reporters: 'verbose',
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
