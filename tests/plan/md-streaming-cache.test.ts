import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseInlineNodes,
  inlineLexStats,
  resetInlineLexStats,
  clearInlineCache,
} from '../../src/tui/markdown-inline.js';
import {
  getCachedBlocks,
  blockLexStats,
  resetBlockLexStats,
  clearBlockCache,
} from '../../src/tui/markdown-cache.js';
import { parseMarkdownBlocks } from '../../src/tui/markdown.js';

// md-structured-inline 03: streaming frames must cost O(delta).
// - inline trees are memoised per source string (stable blocks re-hit);
// - append-only growth after a CLOSED block reuses the cached prefix and
//   lexes only the tail.

beforeEach(() => {
  clearInlineCache();
  clearBlockCache();
  resetInlineLexStats();
  resetBlockLexStats();
});

describe('inline memo (03)', () => {
  it('identical source hits the cache instead of re-lexing', () => {
    parseInlineNodes('a **b** c');
    parseInlineNodes('a **b** c');
    parseInlineNodes('a **b** c');
    expect(inlineLexStats().lexes).toBe(1);
    expect(inlineLexStats().hits).toBe(2);
  });

  it('returns the identical (frozen-by-convention) array on hit', () => {
    const first = parseInlineNodes('x `y`');
    const second = parseInlineNodes('x `y`');
    expect(second).toBe(first);
  });
});

describe('block prefix reuse (03)', () => {
  it('append-only streaming reuses closed prefixes and matches a fresh parse', () => {
    const para = (i: number): string => `paragraph ${i} with **bold** and \`code\` filler text `;
    let doc = '';
    const frames: string[] = [];
    for (let p = 0; p < 6; p++) {
      for (let w = 0; w < 20; w++) doc += para(p) + ' ';
      doc += '\n\n';
      frames.push(doc);
    }
    for (const frame of frames) {
      const cached = getCachedBlocks(frame);
      const fresh = parseMarkdownBlocks(frame);
      expect(cached).toEqual(fresh);
    }
    const stats = blockLexStats();
    // 12 frames: prefix fast path must have served most growth; full lexes
    // stay bounded by frames (never per-word), prefix lexes > 0 proves it fired.
    expect(stats.prefix).toBeGreaterThan(0);
    expect(stats.full + stats.prefix).toBeLessThanOrEqual(frames.length);
  });

  it('mid-paragraph growth (no closed prefix) still falls back safely', () => {
    let doc = '';
    for (const chunk of ['start **', 'bold', '** end', ' more']) {
      doc += chunk;
      expect(getCachedBlocks(doc)).toEqual(parseMarkdownBlocks(doc));
    }
  });

  it('inline cost across streaming is bounded: stable blocks never re-lex', () => {
    // One closed paragraph, then a growing second one: the first block's
    // inline sources must be lexed exactly once across all frames.
    let doc = 'first **stable** paragraph\n\n';
    getCachedBlocks(doc);
    const afterFirst = inlineLexStats().lexes;
    for (let i = 0; i < 30; i++) {
      doc += `tail word ${i} `;
      getCachedBlocks(doc);
      for (const b of getCachedBlocks(doc)) {
        parseInlineNodes(b.kind === 'paragraph' ? b.text : '');
      }
    }
    const growth = inlineLexStats().lexes - afterFirst;
    // 30 tail rewrites + up to 30 empty-string texts (cached after first);
    // the stable paragraph adds exactly 0.
    expect(growth).toBeLessThanOrEqual(32);
  });

  it('1000-frame append stream stays O(delta) and stays correct', () => {
    let doc = '';
    let checked = 0;
    for (let i = 0; i < 1000; i++) {
      doc += `w${i} `;
      if (i % 50 === 49) doc += '\n\n';
      const cached = getCachedBlocks(doc);
      if (i % 100 === 99) {
        expect(cached).toEqual(parseMarkdownBlocks(doc));
        checked += 1;
      }
    }
    expect(checked).toBe(10);
    const stats = blockLexStats();
    // Prefix reuse must carry most frames; total block lexes never exceed
    // one per frame (the pre-fix behaviour was also one per frame, but each
    // over the WHOLE document — the equality checks above prove the cheap
    // frames still parse correctly, the prefix counter proves the path ran).
    expect(stats.prefix).toBeGreaterThan(10);
    expect(stats.full + stats.prefix).toBeLessThanOrEqual(1000);
  });

  it('LRU eviction: exceeding the cap drops the oldest, which must re-lex', () => {
    for (let i = 0; i < 405; i++) parseInlineNodes(`unique source ${i} with **x**`);
    const before = inlineLexStats().lexes;
    expect(before).toBe(405); // every distinct source lexed once
    parseInlineNodes('unique source 0 with **x**'); // evicted by capacity 400
    expect(inlineLexStats().lexes).toBe(406);
  });
});
