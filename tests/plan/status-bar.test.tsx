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
};

describe('StatusBar three-segment footer (tui-refactor 09)', () => {
  it('renders cwd + branch, token/cache/context/cost, and provider + model', () => {
    const { lastFrame } = render(
      <StatusBar
        model="gpt5"
        providerName="oa"
        workingDirectory="/proj"
        gitBranch="main"
        thinkingLevel="medium"
        contextWindow={100_000}
        mcpConnectionCount={2}
        cacheStats={cacheStats}
        modelCost={{ input: 3, output: 15, cacheRead: 0.3 }}
      />,
    );
    const frame = lastFrame() ?? '';
    // Left segment
    expect(frame).toContain('/proj');
    expect(frame).toContain('main');
    expect(frame).toContain('2 MCP');
    // Middle segment
    expect(frame).toContain('↑1.2k');
    expect(frame).toContain('↓340');
    expect(frame).toContain('R1.2k');
    expect(frame).toContain('CH50%');
    expect(frame).toContain('ctx 1%'); // 1.2k / 100k
    expect(frame).toContain('$');
    // Right segment
    expect(frame).toContain('oa/');
    expect(frame).toContain('gpt5');
    expect(frame).toContain('medium');
  });

  it('shows — when the model has no price', () => {
    const { lastFrame } = render(
      <StatusBar
        model="local"
        workingDirectory="/tmp"
        mcpConnectionCount={0}
        contextWindow={1_000}
        cacheStats={cacheStats}
      />,
    );
    expect(lastFrame()).toContain('—');
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
