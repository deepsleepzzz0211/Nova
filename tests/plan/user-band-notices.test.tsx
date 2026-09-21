import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageBubble } from '../../src/tui/MessageBubble.js';
import { MarkdownText } from '../../src/tui/MarkdownText.js';
import { inlineParts } from '../../src/tui/markdown.js';
import { decoratedContextNotice } from '../../src/tui/notice-line.js';
import { displayWidth } from '../../src/tui/text-measure.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

// tui-redesign 07: user messages render as a full-width background band,
// inline code gets green-on-panel styling, compaction notices become a
// centred decorative rule.

const msg = (m: Partial<DisplayMessage> & { role: DisplayMessage['role']; content: string }): DisplayMessage => m;

describe('user message band (tui-redesign 07)', () => {
  it('renders the content band-bordered by blank lines, without the "> " prefix', () => {
    // (ink-testing-library renders no ANSI, so the band COLOUR is covered by
    // the theme token + manual acceptance; structure is covered here.)
    const frame =
      render(<MessageBubble message={msg({ role: 'user', content: '跑下测试' })} />).lastFrame() ?? '';
    expect(frame).toContain('跑下测试');
    expect(frame).not.toContain('>');
    expect(frame.startsWith('\n')).toBe(true); // paddingY blank rows above/below
  });
});

describe('inline code parts (tui-redesign 07)', () => {
  it('splits code spans out of the stripped text', () => {
    expect(inlineParts('run `pnpm test` now')).toEqual([
      { text: 'run ', code: false },
      { text: 'pnpm test', code: true },
      { text: ' now', code: false },
    ]);
  });

  it('still strips bold/link markers inside the parts', () => {
    expect(inlineParts('**a** and `b`')).toEqual([
      { text: 'a and ', code: false },
      { text: 'b', code: true },
    ]);
  });

  it('renders code spans into the paragraph flow without markers', () => {
    const frame = render(<MarkdownText>{'run `pnpm test` now'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('run pnpm test now');
    expect(frame).not.toContain('`');
  });
});

describe('compaction notice line (tui-redesign 07)', () => {
  it('decorates and centres the compaction notice', () => {
    const line = decoratedContextNotice('[context compacted (pressure): 168240 → 41905 tokens]', 80);
    expect(line).not.toBeNull();
    const text = line as string;
    expect(text).toContain('Context compacted');
    expect(text).toContain('168.2k → 41.9k tokens');
    expect(text).toContain('(pressure)');
    expect(displayWidth(text)).toBe(80);
    expect(text).toMatch(/^\s+────/);
  });

  it('covers microcompact and truncate variants', () => {
    expect(decoratedContextNotice('[context micro-compacted (idle): 2000 → 1800 tokens]', 80)).toContain('Context micro-compacted');
    expect(decoratedContextNotice('[context truncated (overflow): 900 → 700 tokens]', 80)).toContain('Context truncated');
  });

  it('passes other system notices through (null)', () => {
    expect(decoratedContextNotice('[context] refill suppressed', 80)).toBeNull();
    expect(decoratedContextNotice('[error] boom', 80)).toBeNull();
  });

  it('MessageBubble renders the decorated rule for compaction system messages', () => {
    const frame =
      render(
        <MessageBubble
          message={msg({ role: 'system', content: '[context compacted (manual): 5000 → 1200 tokens]' })}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('Context compacted');
    expect(frame).not.toContain('[context compacted');
  });
});
