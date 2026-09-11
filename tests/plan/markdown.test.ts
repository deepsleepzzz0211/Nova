import { describe, it, expect } from 'vitest';
import {
  parseMarkdownBlocks,
  highlightToSegments,
  languageOf,
  getCachedBlocks,
  clearBlockCache,
} from '../../src/tui/markdown.js';

describe('markdown pipeline (tui-refactor 07)', () => {
  describe('parseMarkdownBlocks', () => {
    it('parses headings, paragraphs and inline code', () => {
      const blocks = parseMarkdownBlocks('# Title\n\nSome **bold** and `code`.');
      expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
      expect(blocks[0].text).toContain('Title');
      expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
      expect(blocks[1].text).toContain('bold');
      expect(blocks[1].text).toContain('code');
    });

    it('parses bullet and ordered lists', () => {
      const blocks = parseMarkdownBlocks('- one\n- two\n\n1. first\n2. second');
      expect(blocks.filter((b) => b.kind === 'list')).toHaveLength(2);
      const bullets = blocks.filter((b) => b.kind === 'list');
      expect(bullets[0].items).toEqual(['one', 'two']);
      expect(bullets[0].ordered).toBe(false);
      expect(bullets[1].ordered).toBe(true);
      expect(bullets[1].items).toEqual(['first', 'second']);
    });

    it('parses fenced code blocks with their language', () => {
      const blocks = parseMarkdownBlocks('before\n\n```ts\nconst x = 1;\n```\n\nafter');
      const code = blocks.find((b) => b.kind === 'code');
      expect(code).toMatchObject({ kind: 'code', language: 'ts' });
      expect(code?.text).toBe('const x = 1;');
    });

    it('parses blockquotes and tables', () => {
      const quote = parseMarkdownBlocks('> quoted line');
      expect(quote[0]).toMatchObject({ kind: 'quote' });
      expect(quote[0].text).toContain('quoted line');

      const table = parseMarkdownBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(table[0]).toMatchObject({ kind: 'table' });
      expect(table[0].rows?.[0]).toEqual(['a', 'b']);
      expect(table[0].rows?.[1]).toEqual(['1', '2']);
    });
  });

  describe('streaming tolerance', () => {
    it('treats an unclosed code fence as a code block to the end', () => {
      const blocks = parseMarkdownBlocks('intro\n\n```ts\nconst partial = ');
      const code = blocks.find((b) => b.kind === 'code');
      expect(code).toBeDefined();
      expect(code?.text).toContain('const partial =');
    });

    it('degrades a half-written table header to a paragraph', () => {
      const blocks = parseMarkdownBlocks('| a | b |\n| --- ');
      expect(blocks.some((b) => b.kind === 'table')).toBe(false);
      const text = blocks.map((b) => b.text).join('\n');
      expect(text).toContain('| a | b |');
    });

    it('never throws on arbitrary partial input', () => {
      for (const partial of ['**', '```', '|', '> ', '- ', '[link](', '#']) {
        expect(() => parseMarkdownBlocks(partial)).not.toThrow();
      }
    });
  });

  describe('highlightToSegments', () => {
    it('maps hljs spans to segments with class names', () => {
      const segments = highlightToSegments('<span class="hljs-keyword">const</span> x = 1;');
      expect(segments).toEqual([
        { text: 'const', className: 'hljs-keyword' },
        { text: ' x = 1;', className: null },
      ]);
    });

    it('unescapes HTML entities', () => {
      const segments = highlightToSegments('a &amp; b &lt;c&gt;');
      expect(segments.map((s) => s.text).join('')).toBe('a & b <c>');
    });
  });

  describe('languageOf', () => {
    it('normalizes fence info strings', () => {
      expect(languageOf('ts')).toBe('ts');
      expect(languageOf('typescript')).toBe('typescript');
      expect(languageOf('')).toBeNull();
      expect(languageOf('unknown-lang')).toBe('unknown-lang');
    });
  });

  describe('block cache', () => {
    it('returns the same array for identical text and caches misses', () => {
      clearBlockCache();
      const a = getCachedBlocks('hello');
      const b = getCachedBlocks('hello');
      expect(a).toBe(b);

      const c = getCachedBlocks('other');
      expect(c).not.toBe(a);
      expect(getCachedBlocks('hello')).toBe(a);
    });

    it('evicts the oldest entries beyond the cap (observable recompute)', () => {
      clearBlockCache();
      const firstBeforeFlood = getCachedBlocks('text 0');
      for (let i = 1; i < 260; i++) getCachedBlocks('text ' + String(i));
      // 'text 0' was evicted, so it is parsed again -> a different array
      expect(getCachedBlocks('text 0')).not.toBe(firstBeforeFlood);
      // ...and the newest entry is still cached
      const newest = getCachedBlocks('text 259');
      expect(getCachedBlocks('text 259')).toBe(newest);
    });
  });
});
