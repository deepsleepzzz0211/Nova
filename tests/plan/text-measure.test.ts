import { describe, it, expect } from 'vitest';
import { displayWidth, wrappedLineCount, truncateToWidth } from '../../src/tui/text-measure.js';
import { estimateMessageLines } from '../../src/tui/viewport.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

/**
 * Ticket zcode-borrow 09 — display-width pre-measurement: layout math must
 * count TERMINAL COLUMNS, not JS string length, so CJK/emoji text stops
 * making the fullscreen transcript jitter between estimated and rendered
 * heights.
 */

describe('displayWidth', () => {
  it('counts ascii as one column, CJK as two', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('你好world')).toBe(4 + 5);
  });

  it('counts emoji as two columns and zero-width marks as none', () => {
    expect(displayWidth('🎉')).toBe(2);
    expect(displayWidth('👩‍💻')).toBeLessThanOrEqual(4); // family emoji (ZWJ seq)
    expect(displayWidth('a\u0301')).toBe(1); // combining acute folds onto 'a'
    expect(displayWidth('\u200B')).toBe(0); // zero-width space
  });
});

describe('wrappedLineCount', () => {
  it('wraps by display columns, not code units', () => {
    // 12 CJK chars = 24 columns; width 10 → 3 lines (old length/width math said 2)
    expect(wrappedLineCount('你'.repeat(12), 10)).toBe(3);
    // explicit newlines count even when short
    expect(wrappedLineCount('a\nb\nc', 80)).toBe(3);
    // empty text still occupies one line
    expect(wrappedLineCount('', 80)).toBe(1);
    // mixed: one long CJK line + one short
    expect(wrappedLineCount('你好世界你好世界\n短', 8)).toBe(2 + 1);
  });

  it('tolerates zero/negative columns without looping', () => {
    expect(wrappedLineCount('abc', 0)).toBe(1);
    expect(wrappedLineCount('abc', -5)).toBe(1);
  });
});

describe('truncateToWidth', () => {
  it('cuts at a display-column boundary and appends the ellipsis', () => {
    // The '…' counts against the budget: 5 columns → 4 chars + ellipsis
    expect(truncateToWidth('hello world', 5)).toBe('hell…');
    // 你好 = 4 columns; budget 5 leaves room for neither a second glyph nor
    // more than the ellipsis width rule → at most 4 + ellipsis(1) = 5
    expect(displayWidth(truncateToWidth('你好世界', 5))).toBeLessThanOrEqual(5);
    expect(truncateToWidth('短', 80)).toBe('短'); // no truncation needed
    expect(truncateToWidth('你好世界你好世界', 9)).toBe('你好世界…');
  });
});

describe('viewport estimation uses display columns', () => {
  const msg = (content: string, over: Partial<DisplayMessage> = {}): DisplayMessage => ({
    id: 'm1',
    role: 'assistant',
    content,
    ...over,
  } as DisplayMessage);

  it('CJK-heavy messages estimate MORE lines than naive char/width math', () => {
    const cjk = '你'.repeat(24); // 48 columns
    const latin = 'a'.repeat(24); // 24 columns
    const options = { width: 20 };
    const cjkLines = estimateMessageLines(msg(cjk), options);
    const latinLines = estimateMessageLines(msg(latin), options);
    // 48/20 → 3 lines; 24/20 → 2 lines. The old length-based math made both 2.
    expect(cjkLines).toBe(3);
    expect(latinLines).toBe(2);
  });

  it('multiline thinking contributes its own rows', () => {
    const m = msg('answer', { thinking: 'think\nthink\nthink' });
    const lines = estimateMessageLines(m, { width: 80 });
    // thinking: 3 wrapped lines + 1 marker line; content: 1
    expect(lines).toBe(5);
  });
});
