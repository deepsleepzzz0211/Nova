import { describe, it, expect } from 'vitest';
import {
  estimateMessageLines,
  estimateTotalLines,
  viewportSlice,
} from '../../src/tui/viewport.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

const msg = (content: string): DisplayMessage => ({ role: 'assistant', content });

describe('fullscreen viewport (tui-refactor 12)', () => {
  describe('estimateMessageLines', () => {
    it('counts content lines and wraps by width', () => {
      expect(estimateMessageLines(msg('one line'), { width: 80 })).toBe(1);
      expect(estimateMessageLines(msg('x'.repeat(200)), { width: 80 })).toBe(3);
    });

    it('counts thinking, tool summaries and expanded results', () => {
      const withThinking: DisplayMessage = { role: 'assistant', content: 'a', thinking: 'why' };
      expect(estimateMessageLines(withThinking)).toBeGreaterThan(estimateMessageLines(msg('a')));

      const withTool: DisplayMessage = {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', status: 'done', result: 'a\nb\nc' }],
      };
      const collapsed = estimateMessageLines(withTool, { expanded: false });
      const expanded = estimateMessageLines(withTool, { expanded: true });
      expect(collapsed).toBe(1);
      expect(expanded).toBeGreaterThan(collapsed);
    });

    it('never returns zero for an empty message', () => {
      expect(estimateMessageLines({ role: 'assistant', content: '' })).toBe(1);
    });
  });

  describe('viewportSlice', () => {
    const conversation = Array.from({ length: 20 }, (_, i) => msg(`message ${i + 1}`));

    it('shows the newest messages when following the end', () => {
      const slice = viewportSlice(conversation, { rows: 5, offset: 0 });
      expect(slice.atBottom).toBe(true);
      expect(slice.messages.at(-1)?.content).toBe('message 20');
      expect(slice.messages.length).toBeLessThanOrEqual(5);
      expect(slice.hiddenAbove).toBeGreaterThan(0);
    });

    it('scrolls back by whole messages and reports the hidden count', () => {
      const bottom = viewportSlice(conversation, { rows: 5, offset: 0 });
      const up = viewportSlice(conversation, { rows: 5, offset: bottom.messages.length });
      expect(up.atBottom).toBe(false);
      expect(up.messages.at(-1)?.content).not.toBe('message 20');
      expect(up.hiddenAbove).toBeLessThan(bottom.hiddenAbove);
    });

    it('clamps an offset past the oldest message', () => {
      const slice = viewportSlice(conversation, { rows: 5, offset: 999 });
      expect(slice.messages[0].content).toBe('message 1');
      expect(slice.maxOffset).toBe(15); // 20 messages, 5 fit
      expect(slice.atBottom).toBe(false);
    });

    it('always shows at least one message even when it exceeds the window', () => {
      const huge = [msg('x'.repeat(5000))];
      const slice = viewportSlice(huge, { rows: 2, offset: 0 });
      expect(slice.messages).toHaveLength(1);
    });

    it('handles an empty conversation', () => {
      expect(viewportSlice([], { rows: 10, offset: 0 })).toEqual({
        messages: [],
        hiddenAbove: 0,
        atBottom: true,
        maxOffset: 0,
      });
    });

    it('follows the end as new messages arrive', () => {
      const before = viewportSlice(conversation, { rows: 4, offset: 0 });
      const after = viewportSlice([...conversation, msg('message 21')], { rows: 4, offset: 0 });
      expect(after.messages.at(-1)?.content).toBe('message 21');
      expect(after.atBottom).toBe(true);
      expect(before.messages.at(-1)?.content).toBe('message 20');
    });
  });

  describe('estimateTotalLines', () => {
    it('sums the conversation', () => {
      expect(estimateTotalLines([msg('a'), msg('b')])).toBe(2);
      expect(estimateTotalLines([])).toBe(0);
    });
  });
});
