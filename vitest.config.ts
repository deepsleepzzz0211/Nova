import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/plan/**/*.test.ts', 'tests/plan/**/*.test.tsx'],
    // Live network tests live in tests/live/ and run via `pnpm test:live`
    // (their own config), never in the default suite.
  },
});
