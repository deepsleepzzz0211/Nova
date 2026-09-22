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
