import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { MarkdownText } from '../../src/tui/MarkdownText.js';

describe('MarkdownText (tui-refactor 07)', () => {
  it('renders headings, paragraphs, bold and inline code as plain text', () => {
    const { lastFrame } = render(
      <MarkdownText>{'# Title\n\nSome **bold** and `code` here.'}</MarkdownText>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('Some bold and code here.'); // markers stripped
    expect(frame).not.toContain('**');
  });

  it('renders bullet and ordered lists with markers', () => {
    const { lastFrame } = render(<MarkdownText>{'- one\n- two\n\n1. first\n2. second'}</MarkdownText>);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('• one');
    expect(frame).toContain('• two');
    expect(frame).toContain('1. first');
    expect(frame).toContain('2. second');
  });

  it('renders code blocks with their content preserved', () => {
    const { lastFrame } = render(
      <MarkdownText>{'```ts\nconst answer = 42;\n```'}</MarkdownText>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('const');
    expect(frame).toContain('answer');
    expect(frame).toContain('42');
  });

  it('renders a partially streamed code fence without crashing', () => {
    const { lastFrame } = render(<MarkdownText>{'intro\n\n```ts\nconst partial = '}</MarkdownText>);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('intro');
    expect(frame).toContain('const partial =');
  });

  it('renders blockquotes and tables', () => {
    const { lastFrame } = render(
      <MarkdownText>{'> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'}</MarkdownText>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('quoted');
    expect(frame).toContain('a | b');
    expect(frame).toContain('1 | 2');
  });

  it('does not throw on arbitrary partial markdown', () => {
    for (const partial of ['**', '```', '|', '> ', '- ', '[link](', '#']) {
      expect(() => render(<MarkdownText>{partial}</MarkdownText>)).not.toThrow();
    }
  });
});
