import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MessageBubble } from '../../src/tui/MessageBubble.js';
import { latestExpandableId } from '../../src/tui/message-partition.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

// tui-redesign 09: the reasoning stream collapses behind a `– Thought 4.2s`
// header; Ctrl+O's expand cycle covers thoughts as well as tool blocks.

const think = (over: Partial<DisplayMessage> = {}): DisplayMessage => ({
  role: 'assistant',
  content: 'the answer',
  thinking: 'musing about musing',
  ...over,
});

describe('thought header (tui-redesign 09)', () => {
  it('collapsed by default: header visible, body hidden', () => {
    const frame = render(<MessageBubble message={think()} />).lastFrame() ?? '';
    expect(frame).toContain('+ Thought');
    expect(frame).not.toContain('musing about');
    expect(frame).toContain('the answer');
  });

  it('expanded shows the body under a ruled column and flips the marker', () => {
    const frame =
      render(<MessageBubble message={think()} thinkingExpanded />).lastFrame() ?? '';
    expect(frame).toContain('– Thought');
    expect(frame).toContain('musing about musing');
  });

  it('reports the duration when measured', () => {
    const frame =
      render(<MessageBubble message={think({ thinkingSeconds: 4.23 })} />).lastFrame() ?? '';
    expect(frame).toContain('Thought 4.2s');
  });

  it('live thinking shows the spinner label instead of a header', () => {
    const frame =
      render(<MessageBubble message={think()} thinkingActive />).lastFrame() ?? '';
    expect(frame).toContain('Thinking…');
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(frame)).toBe(true);
  });
});

describe('latestExpandableId (tui-redesign 09)', () => {
  const call = { id: 'c1', name: 'bash', arguments: '{}', status: 'done' as const };

  it('prefers the newest expandable block, tool or thought', () => {
    const withTool: DisplayMessage = { role: 'assistant', content: '', toolCalls: [call] };
    expect(latestExpandableId([withTool, think()])).toBe('msg:1');
    expect(latestExpandableId([think(), withTool])).toBe('c1');
    expect(latestExpandableId([think()])).toBe('msg:0');
    expect(latestExpandableId([{ role: 'user', content: 'hi' }])).toBeNull();
  });
});
