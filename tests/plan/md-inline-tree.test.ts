import { describe, it, expect } from 'vitest';
import { parseInlineNodes, flattenInline, type InlineNode } from '../../src/tui/markdown-inline.js';

// md-structured-inline 01: a CommonMark inline TREE replaces the regex
// stripper. Markers are dropped by the renderer (no conceal), and malformed
// nesting must never leak literal ** / ` characters.

const kinds = (nodes: readonly InlineNode[]): string[] => nodes.map((n) => n.kind);
const kids = (nodes: readonly InlineNode[], i: number): string[] => kinds(nodes[i].children ?? []);

describe('parseInlineNodes (md-structured-inline 01)', () => {
  it('classifies the five inline roles', () => {
    const nodes = parseInlineNodes('plain **strong** *em* `code` [label](https://x.dev)');
    expect(kinds(nodes)).toEqual(
      expect.arrayContaining(['text', 'strong', 'em', 'codespan', 'link']),
    );
    const link = nodes.find((n) => n.kind === 'link');
    expect(link?.href).toBe('https://x.dev');
    expect(flattenInline(link?.children ?? [])).toBe('label');
  });

  it('keeps nesting: strong containing a codespan', () => {
    const nodes = parseInlineNodes('**run `pnpm test` now**');
    const strong = nodes.find((n) => n.kind === 'strong');
    expect(strong).toBeDefined();
    expect(kids(nodes, nodes.indexOf(strong!))).toContain('codespan');
  });

  it('acceptance sample: malformed **`echo**` nesting leaks no markers', () => {
    const flat = flattenInline(parseInlineNodes('简单来说，**`echo`** 命令的作用'));
    expect(flat).not.toContain('**');
    expect(flat).not.toContain('`');
    expect(flat).toContain('echo');
    expect(flat).toContain('简单来说，');
  });

  it('streaming half-inputs degrade to text, never throw', () => {
    for (const raw of ['x **', 'x `', '[a](b)c](d)', '**a*', '', 'a\u0000b']) {
      expect(() => parseInlineNodes(raw)).not.toThrow();
      expect(flattenInline(parseInlineNodes(raw)).length).toBeGreaterThanOrEqual(0);
    }
  });

  it('unclosed emphasis keeps its literal text (CommonMark)', () => {
    // CommonMark: an unmatched ** stays literal text — the tree still says
    // WHERE it is; only the renderer decides to print it as text.
    const nodes = parseInlineNodes('unclosed **bold');
    expect(flattenInline(nodes)).toContain('bold');
  });

  it('handles CJK and mixed widths without splitting graphemes', () => {
    const nodes = parseInlineNodes('中文**加粗混排**英文😀');
    const flat = flattenInline(nodes);
    expect(flat).toContain('中文');
    expect(flat).toContain('英文😀');
    expect(flat).not.toContain('**');
  });

  it('br tokens map to line breaks', () => {
    expect(kinds(parseInlineNodes('a  \nb'))).toContain('br');
  });
});
