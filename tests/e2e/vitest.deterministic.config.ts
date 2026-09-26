import { defineConfig } from 'vitest/config';

/**
 * Deterministic TUI E2E: real PTY, no LLM calls, no API key. Runs in CI on
 * every PR (ubuntu + windows). Requires a build (`pnpm build`) because the
 * suite drives dist/index.js.
 */
export default defineConfig({
  test: {
    include: [
      'tests/e2e/tui/tui-deterministic.test.ts',
      'tests/e2e/cli-flags.test.ts',
      'tests/e2e/recorded-replay.test.ts',
      'tests/e2e/protocol-route.test.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    // One automatic retry per failing case (p1-p2 01, report-8): real-PTY
    // timing flakes must not red-gate a release, while genuine regressions
    // fail both attempts anyway. lessons.md 教训37 class of "PTY blocked
    // the publish" incidents. NOTE: vitest 4 renamed `retries` to `retry` —
    // the old key is silently ignored (proved by demo).
    retry: 1,
  },
});
