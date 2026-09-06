import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/plan/**/*.test.ts'],
    // Live network tests live in tests/live/ and run via `pnpm test:live`
    // (their own config), never in the default suite.
  },
});
