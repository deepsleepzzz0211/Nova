import { describe, it, expect } from 'vitest';
import {
  parseMarkdownBlocks,
  highlightToSegments,
  highlightedLines,
  clearBlockCache,
} from '../../src/tui/markdown.js';

describe('markdown review fixes (ticket 07)', () => {
  describe('entity decoding', () => {
    it('decodes the apostrophe entity hljs emits', () => {
      const segments = highlightToSegments("it&#x27;s a string");
      expect(segments.map((s) => s.text).join('')).toBe("it's a string");
    });

    it('decodes numeric and hexadecimal entities', () => {
      const segments = highlightToSegments('&#65;&#x42; &amp; &quot;q&quot;');
      expect(segments.map((s) => s.text).join('')).toBe('AB & "q"');
    });
  });

  describe('span parsing', () => {
    it('keeps colors for a span that contains newlines', () => {
      // hljs emits multi-line comment spans; the old per-line split leaked
      // raw </span> text and dropped the class on continuation lines.
      const html = '<span class="hljs-comment">line one\nline two</span> after';
      const segments = highlightToSegments(html);
      expect(segments).toEqual([
        { text: 'line one\nline two', className: 'hljs-comment' },
        { text: ' after', className: null },
      ]);
    });

    it('handles nested spans without leaking closing tags', () => {
      const html =
        '<span class="hljs-string">a<span class="hljs-subst">${x}</span>b</span>';
      const segments = highlightToSegments(html);
      expect(segments.map((s) => s.text).join('')).toBe('a${x}b');
      expect(segments.some((s) => s.text.includes('</span>'))).toBe(false);
      expect(segments.some((s) => s.className === 'hljs-subst')).toBe(true);
    });
  });

  describe('highlightedLines', () => {
    it('splits highlighted output into per-line segments', () => {
      const lines = highlightedLines('const a = 1;\nconst b = 2;', 'javascript');
      expect(lines).toHaveLength(2);
      expect(lines[0].map((s) => s.text).join('')).toBe('const a = 1;');
      expect(lines[1].map((s) => s.text).join('')).toBe('const b = 2;');
      // keywords are highlighted, not plain
      expect(lines[0].some((s) => s.className?.includes('keyword'))).toBe(true);
    });

    it('memoises highlighting so re-renders do not re-highlight', () => {
      clearBlockCache();
      const a = highlightedLines('let x = 1;', 'javascript');
      const b = highlightedLines('let x = 1;', 'javascript');
      expect(a).toBe(b);
    });
  });

  describe('block content fidelity', () => {
    it('keeps nested list content instead of dropping it', () => {
      const blocks = parseMarkdownBlocks('- parent\n  - child\n- second');
      const list = blocks.find((b) => b.kind === 'list');
      expect(list?.items?.[0]).toContain('parent');
      expect(list?.items?.[0]).toContain('child');
    });

    it('respects an ordered list start number', () => {
      const blocks = parseMarkdownBlocks('3. three\n4. four');
      const list = blocks.find((b) => b.kind === 'list');
      expect(list?.ordered).toBe(true);
      expect(list?.start).toBe(3);
    });

    it('pads table columns so rows line up', () => {
      const blocks = parseMarkdownBlocks('| name | v |\n| --- | --- |\n| longer | 1 |');
      const table = blocks.find((b) => b.kind === 'table');
      const widths = table?.rows?.map((r) => r[0].length) ?? [];
      expect(new Set(widths).size).toBe(1); // same padded width
    });

    it('renders horizontal rules as their own block', () => {
      const blocks = parseMarkdownBlocks('a\n\n---\n\nb');
      expect(blocks.some((b) => b.kind === 'rule')).toBe(true);
    });

    it('extracts blockquote text through nested tokens', () => {
      const blocks = parseMarkdownBlocks('> quoted **word**');
      expect(blocks[0]).toMatchObject({ kind: 'quote' });
      expect(blocks[0].text).toContain('quoted');
    });
  });
});
