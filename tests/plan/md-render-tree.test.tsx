import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MarkdownText } from '../../src/tui/MarkdownText.js';
import { INLINE_STYLE } from '../../src/tui/markdown-inline.js';
import { theme } from '../../src/tui/theme.js';

// md-structured-inline 02: the renderer walks the InlineNode tree; styles
// come from ONE declarative kind→style table (ZCode capture→token model).
// (ink-testing-library strips ANSI, so text-level evidence only; the style
// table itself is asserted as data.)

describe('tree renderer (md-structured-inline 02)', () => {
  it('malformed emphasis leaks no markers (the live-acceptance sample)', () => {
    const frame = render(<MarkdownText>{'简单来说，**`echo`** 命令'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('echo');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`');
  });

  it('well-formed nesting keeps text and drops markers', () => {
    const frame = render(<MarkdownText>{'run **bold `code` here** now'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('run bold code here now');
    expect(frame).not.toContain('*');
  });

  it('links render label plus a dim url tail', () => {
    const frame = render(<MarkdownText>{'see [docs](https://nova.dev) for more'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('docs (https://nova.dev)');
    expect(frame).not.toContain('[');
  });

  it('strikethrough and hard breaks render', () => {
    const frame = render(<MarkdownText>{'a ~~gone~~ b  \nnext'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('a gone b');
    expect(frame).toContain('next');
    expect(frame).not.toContain('~~');
  });

  it('headings and list items go through the tree too', () => {
    const frame = render(<MarkdownText>{'# T **x**\n- item `y` **z**'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('T x');
    expect(frame).toContain('item y z');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`');
  });

  it('table cells go through the tree and align by VISIBLE width', () => {
    // Raw markers must not count into column width (ticket 02 checkbox:
    // 表格单元格 through the tree).
    const frame =
      render(<MarkdownText>{'| h1 | **h2** |\n| --- | --- |\n| `a` | bb |'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`');
    expect(frame).toContain('h1');
    expect(frame).toContain('h2');
    expect(frame).toContain('a');
    // Column alignment: both rows' second column start at the same offset.
    const lines = frame.split('\n').filter((l) => l.includes('h1') || l.includes('bb'));
    const col2 = lines.map((l) => l.indexOf('h2') >= 0 ? l.indexOf('h2') : l.indexOf('bb'));
    expect(col2[0]).toBe(col2[1]);
  });

  it('quote with inline formatting renders its text exactly once', () => {
    // textOfTokens used to push token.text AND descend into token.tokens,
    // duplicating the content (found in the md-structured-inline 04 run).
    const frame = render(<MarkdownText>{'> 引用里的 **粗体** 与 `代码`'}</MarkdownText>).lastFrame() ?? '';
    expect(frame).toContain('引用里的 粗体 与 代码');
    expect(frame.split('引用里的').length - 1).toBe(1);
  });
});

describe('style table (md-structured-inline 02)', () => {
  it('is one declarative map keyed by node kind', () => {
    expect(Object.keys(INLINE_STYLE).sort()).toEqual(
      ['br', 'codespan', 'del', 'em', 'link', 'strong', 'text'].sort(),
    );
    expect(INLINE_STYLE.strong.bold).toBe(true);
    expect(INLINE_STYLE.em.italic).toBe(true);
    expect(INLINE_STYLE.del.strikethrough).toBe(true);
    expect(INLINE_STYLE.codespan.backgroundColor).toBe(theme.panel);
    expect(INLINE_STYLE.link.underline).toBe(true);
  });
});
