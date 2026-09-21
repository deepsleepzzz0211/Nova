import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { StatusLine } from '../../src/tui/StatusLine.js';
import type { CacheStatsView } from '../../src/tui/display-types.js';

// tui-redesign 02: the top StatusBar is retired; one bottom line under the
// input carries the working indicator and usage badges. The cache hit-rate
// badge (CH%) must survive the move (explicit user requirement).

const stats = (over: Partial<CacheStatsView> = {}): CacheStatsView => ({
  hitRate: 0.5,
  latestHitRate: 0.5,
  totalCachedTokens: 1_200,
  totalCacheWriteTokens: 300,
  totalInputTokens: 1_200,
  totalOutputTokens: 340,
  contextTokens: 1_200,
  contextTriggerTokens: 100_000,
  ...over,
});

describe('StatusLine (tui-redesign 02)', () => {
  it('shows spinner + esc to interrupt while working', () => {
    const { lastFrame } = render(<StatusLine working="streaming" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('esc to interrupt');
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(frame)).toBe(true);
  });

  it('labels the thinking state distinctly from streaming', () => {
    const { lastFrame } = render(<StatusLine working="thinking" />);
    expect(lastFrame() ?? '').toContain('Thinking…');
    const s = render(<StatusLine working="streaming" />);
    expect(s.lastFrame() ?? '').not.toContain('Thinking…');
  });

  it('renders usage badges: tokens, cache CH%, context, cost', () => {
    const { lastFrame } = render(
      <StatusLine working="idle" cacheStats={stats()} modelCost={{ input: 2, output: 5 }} contextWindow={100_000} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑1.2k ↓340');
    expect(frame).toContain('R1.2k W300 CH50%');
    expect(frame).toContain('1.2k (1%)');
    expect(frame).toMatch(/\$\d/);
  });

  it('keeps the cache badge even when only writes happened', () => {
    const { lastFrame } = render(
      <StatusLine
        working="idle"
        cacheStats={stats({ totalCachedTokens: 0, totalCacheWriteTokens: 500, latestHitRate: 0 })}
      />,
    );
    expect(lastFrame() ?? '').toContain('CH0%');
  });

  it('warns on high context usage with ⚠', () => {
    const { lastFrame } = render(
      <StatusLine working="idle" cacheStats={stats({ contextTokens: 90_000 })} contextWindow={100_000} />,
    );
    expect(lastFrame() ?? '').toContain('(90%) ⚠');
  });

  it('shows an em dash cost when the model has no price', () => {
    const { lastFrame } = render(<StatusLine working="idle" cacheStats={stats()} contextWindow={100_000} />);
    expect(lastFrame() ?? '').toContain('· —');
  });

  it('renders update notice and subagent activity rows when present', () => {
    const { lastFrame } = render(
      <StatusLine working="idle" updateNotice="⬆ update available: 0.2.0 (run /update)" subagentActivity="agent-3 ▸ bash" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⬆ update available');
    expect(frame).toContain('agent-3 ▸ bash');
  });

  it('collapses to nothing when idle with no data to show', () => {
    const { lastFrame } = render(<StatusLine working="idle" />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});
