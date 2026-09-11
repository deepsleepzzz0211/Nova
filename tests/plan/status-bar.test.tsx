import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusBar } from '../../src/tui/StatusBar.js';

// Small numbers: the ink-testing-library terminal is 100 columns wide.
const cacheStats = {
  hitRate: 0.5,
  latestHitRate: 0.5,
  totalCachedTokens: 1_200,
  totalCacheWriteTokens: 300,
  totalInputTokens: 1_200,
  totalOutputTokens: 340,
  // Current context size = last request's prompt tokens (review fix: the
  // session total would saturate the gauge).
  contextTokens: 1_200,
};

describe('StatusBar three-segment footer (tui-refactor 09)', () => {
  it('renders cwd + branch, token/cache/context/cost, and provider + model', () => {
    const { lastFrame } = render(
      <StatusBar
        model="g"
        providerName="o"
        workingDirectory="/p"
        gitBranch="main"
        thinkingLevel="med"
        contextWindow={100_000}
        mcpConnectionCount={2}
        cacheStats={cacheStats}
        contextStrategy="compact"
        modelCost={{ input: 3, output: 15, cacheRead: 0.3 }}
      />,
    );
    const frame = lastFrame() ?? '';
    // Left segment
    expect(frame).toContain('/p');
    expect(frame).toContain('main');
    expect(frame).toContain('2 MCP');
    // Middle segment
    expect(frame).toContain('↑1.2k');
    expect(frame).toContain('↓340');
    expect(frame).toContain('R1.2k');
    expect(frame).toContain('CH50%');
    expect(frame).toContain('ctx 1%/100.0k'); // last request 1.2k / window 1k
    expect(frame).toContain('$');
    expect(frame).toContain('(compact)');
    // Right segment
    expect(frame).toContain('o/');
    expect(frame).toContain('g');
    expect(frame).toContain('med');
  });

  it('shows — for cost before any usage is recorded', () => {
    const { lastFrame } = render(
      <StatusBar
        model="m"
        workingDirectory="/w"
        mcpConnectionCount={0}
        contextWindow={1000}
        cacheStats={{
          hitRate: 0,
          latestHitRate: 0,
          totalCachedTokens: 0,
          totalCacheWriteTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          contextTokens: 0,
        }}
        modelCost={{ input: 3, output: 15 }}
      />,
    );
    expect(lastFrame()).toContain('—');
  });

  it('shows — when the model has no price', () => {
    const { lastFrame } = render(
      <StatusBar
        model="local"
        workingDirectory="/tmp"
        mcpConnectionCount={0}
        contextWindow={100_000}
        cacheStats={cacheStats}
      />,
    );
    expect(lastFrame()).toContain('—');
  });

  it('warns when the context is close to the compaction trigger', () => {
    const { lastFrame } = render(
      <StatusBar
        model="m"
        workingDirectory="/w"
        mcpConnectionCount={0}
        cacheStats={{ ...cacheStats, contextTokens: 9_000, contextTriggerTokens: 10_000, totalInputTokens: 9_000 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ctx 90%');
    expect(frame).toContain('⚠');
  });

  it('renders without cache stats (nothing measured yet)', () => {
    const { lastFrame } = render(
      <StatusBar model="m" workingDirectory="/w" mcpConnectionCount={0} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('m');
    expect(frame).not.toContain('ctx');
  });

  it('shows the live subagent activity and update notice lines', () => {
    const { lastFrame } = render(
      <StatusBar
        model="m"
        workingDirectory="/w"
        mcpConnectionCount={0}
        subagentActivity="abc123 ▸ read"
        updateNotice="update available"
      />,
    );
    expect(lastFrame()).toContain('abc123 ▸ read');
    expect(lastFrame()).toContain('update available');
  });
});
