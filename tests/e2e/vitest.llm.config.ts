import { defineConfig } from 'vitest/config';

/**
 * Real-LLM TUI E2E: drives the built binary in a real PTY against a real
 * endpoint. LOCAL ONLY — never runs in CI (no secrets in CI). See
 * docs/e2e.md for the key setup.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/tui/tui-interaction.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
