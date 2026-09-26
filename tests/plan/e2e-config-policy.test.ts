import { describe, it, expect } from 'vitest';
import deterministicConfig from '../../tests/e2e/vitest.deterministic.config.js';
import llmConfig from '../../tests/e2e/vitest.llm.config.js';

// p1-p2 01 (report-8): the deterministic PTY gate retries once so a single
// timing flake cannot red-gate a publish, while the real-LLM suite keeps its
// own policy. These assertions pin the CONFIG values — drift fails here
// instead of silently changing CI behaviour.

describe('e2e vitest configs retry policy (p1-p2 01)', () => {
  it('deterministic PTY suite retries a failed case once', () => {
    // vitest 4 spellings: `retry` (not the v3 `retries`, which is silently
    // dead — a demo run proved the old key never fired a second attempt).
    expect(deterministicConfig.test?.retry).toBe(1);
    expect((deterministicConfig.test as Record<string, unknown>)?.retries).toBeUndefined();
  });

  it('the LLM e2e suite does not silently inherit the retry policy', () => {
    expect(llmConfig.test?.retry ?? 0).toBe(0);
  });
});
