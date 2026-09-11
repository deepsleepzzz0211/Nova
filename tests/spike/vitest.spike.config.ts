import { defineConfig } from 'vitest/config';

/** Spike config: exploratory tui-test runs (ticket e2e-testing 02). */
export default defineConfig({
  test: {
    include: ['tests/spike/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
