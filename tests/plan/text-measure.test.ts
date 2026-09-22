import { describe, it, expect } from 'vitest';
import { displayWidth, wrappedLineCount, truncateToWidth, padToWidth } from '../../src/tui/text-measure.js';
import { estimateMessageLines, viewportSlice } from '../../src/tui/viewport.js';
import { getCachedBlocks } from '../../src/tui/markdown-cache.js';
import type { DisplayMessage } from '../../src/tui/display-types.js';

/**
 * Ticket zcode-borrow 09 — display-width pre-measurement: layout math must
 * count TERMINAL COLUMNS, not JS string length, so CJK/emoji text stops
 * making the fullscreen transcript jitter between estimated and rendered
 * heights.
 */

function msg(content: string, over: Partial<DisplayMessage> = {}): DisplayMessage {
  return { role: 'assistant', content, ...over } as DisplayMessage;
}

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

  it('thinking counts one collapsed header row, plus its body when expanded', () => {
    const m = msg('answer', { thinking: 'think\nthink\nthink' });
    // Collapsed (tui-redesign 09 default): 1 header + 1 content.
    expect(estimateMessageLines(m, { width: 80 })).toBe(2);
    // Expanded: 3 wrapped thinking rows + header + content.
    expect(estimateMessageLines(m, { width: 80, thinkingExpanded: true })).toBe(5);
  });
});

describe('layout consumes real terminal width', () => {
  it('a narrow viewport yields MORE estimated lines than the 80-col default', () => {
    const body = 'word '.repeat(60); // 300 latin chars
    const m = msg(body);
    const wide = estimateMessageLines(m, { width: 100 });
    const narrow = estimateMessageLines(m, { width: 40 });
    expect(narrow).toBeGreaterThan(wide);
  });

  it('viewportSlice honors the width option when choosing the window', () => {
    const body = '你'.repeat(120); // 240 columns of CJK
    const messages = [msg(body), msg('second'), msg('third')];
    const wide = viewportSlice(messages, { rows: 4, offset: 0, width: 120 });
    const narrow = viewportSlice(messages, { rows: 4, offset: 0, width: 30 });
    // Same row budget: the narrow terminal fits fewer messages.
    expect(narrow.messages.length).toBeLessThanOrEqual(wide.messages.length);
    expect(narrow.hiddenAbove).toBeGreaterThanOrEqual(wide.hiddenAbove);
  });
});

describe('markdown tables align by display columns', () => {
  it('CJK cells pad to equal display width so the | borders line up', () => {
    const md = [
      '| 名称 | 数量 |',
      '| --- | --- |',
      '| 你好世界 | 3 |',
      '| ab | 10 |',
    ].join('\n');
    const blocks = getCachedBlocks(md);
    const table = blocks.find((b): b is { kind: 'table'; rows: string[][] } => b.kind === 'table');
    expect(table).toBeDefined();
    const rows = table!.rows;
    // Every row's first column is the same number of terminal columns.
    const firstColWidths = rows.map((r) => displayWidth(r[0] ?? ''));
    expect(new Set(firstColWidths).size).toBe(1);
  });
});

describe('grapheme safety', () => {
  it('does not split an emoji ZWJ sequence when truncating', () => {
    const cluster = '👩‍💻'; // one grapheme (person + ZWJ + laptop)
    const cut = truncateToWidth(`${cluster}${cluster} tail`, 4);
    // Whatever survives must be whole clusters, never a lone half-cluster
    // (a trailing ZWJ or isolated surrogate).
    expect(displayWidth(cut)).toBeLessThanOrEqual(4);
    const kept = cut.endsWith('…') ? cut.slice(0, -1) : cut;
    // The kept prefix, with every whole cluster removed, must be empty —
    // proving no partial cluster (dangling ZWJ / lone surrogate) leaked in.
    expect(kept.split(cluster).join('')).toBe('');
  });

  it('padToWidth reaches the target columns exactly', () => {
    expect(displayWidth(padToWidth('你好', 8))).toBe(8);
    expect(padToWidth('already long enough', 5)).toBe('already long enough');
  });
});
