import { describe, it, expect } from 'vitest';
import {
  buildGrepArgs,
  parseFilesList,
  parseCountList,
  parseContentEvents,
  paginate,
  renderClip,
  toSlashes,
} from '../../src/tools/ripgrep-search.js';

// Pure seams of the grep tool: ripgrep argv construction, --json/--null output
// parsing, and pagination. The WASM engine needs forward-slash paths on
// Windows (backslashes are eaten by the guest), so path normalization is a
// first-class contract here, not an afterthought.

describe('toSlashes', () => {
  it('converts backslash separators to forward slashes', () => {
    expect(toSlashes('D:\\project\\codeagent\\src')).toBe('D:/project/codeagent/src');
  });
  it('leaves already-posix paths untouched', () => {
    expect(toSlashes('src/tools/grep.ts')).toBe('src/tools/grep.ts');
  });
});

describe('buildGrepArgs', () => {
  it('defaults to files-with-matches with NUL-safe output and no user config', () => {
    const args = buildGrepArgs({
      pattern: 'cacheRetention',
      searchPath: 'D:/project/codeagent/src',
      outputMode: 'files',
    });
    expect(args).toContain('--no-config');
    expect(args).toContain('-l');
    expect(args).toContain('--null');
    expect(args).toContain('-e');
    expect(args).toContain('cacheRetention');
    expect(args).toContain('--');
    expect(args[args.length - 1]).toBe('D:/project/codeagent/src');
    expect(args.join(' ')).not.toContain('\\');
  });

  it('uses --json for content mode so line numbers and context survive parsing', () => {
    const args = buildGrepArgs({
      pattern: 'foo',
      searchPath: '/tmp/x',
      outputMode: 'content',
      beforeContext: 2,
      afterContext: 3,
    });
    expect(args).toContain('--json');
    expect(args).not.toContain('-l');
    expect(args).toContain('-B');
    expect(args).toContain('2');
    expect(args).toContain('-A');
    expect(args).toContain('3');
  });

  it('maps context/-C to a symmetric flag', () => {
    const args = buildGrepArgs({ pattern: 'foo', searchPath: '/tmp/x', outputMode: 'content', context: 4 });
    const i = args.indexOf('-C');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('4');
  });

  it('ignores context flags outside content mode (matches the tool description)', () => {
    const args = buildGrepArgs({
      pattern: 'foo',
      searchPath: '/tmp/x',
      outputMode: 'count',
      context: 5,
      beforeContext: 1,
    });
    expect(args).not.toContain('-C');
    expect(args).not.toContain('-B');
    expect(args).toContain('-c');
  });

  it('maps the boolean flags: -i, -o, multiline', () => {
    const args = buildGrepArgs({
      pattern: 'foo',
      searchPath: '/tmp/x',
      outputMode: 'content',
      ignoreCase: true,
      onlyMatching: true,
      multiline: true,
    });
    expect(args).toContain('-i');
    expect(args).toContain('-o');
    expect(args).toContain('-U');
    expect(args).toContain('--multiline-dotall');
  });

  it('maps glob and type filters', () => {
    const args = buildGrepArgs({
      pattern: 'foo',
      searchPath: '/tmp/x',
      outputMode: 'files',
      glob: '*.tsx',
      type: 'js',
    });
    expect(args).toContain('--glob');
    expect(args).toContain('*.tsx');
    expect(args).toContain('--type');
    expect(args).toContain('js');
  });

  it('treats a pattern starting with a dash as a pattern, not a flag', () => {
    const args = buildGrepArgs({ pattern: '--debug', searchPath: '/tmp/x', outputMode: 'files' });
    const i = args.indexOf('-e');
    expect(args[i + 1]).toBe('--debug');
  });
});

describe('parseFilesList', () => {
  it('splits NUL-separated paths, dropping the trailing empty piece', () => {
    expect(parseFilesList('a.ts\u0000b/c.ts\u0000')).toEqual(['a.ts', 'b/c.ts']);
  });
  it('returns an empty list for empty output', () => {
    expect(parseFilesList('')).toEqual([]);
  });
});

describe('parseCountList', () => {
  it('parses "path\\0count" lines', () => {
    expect(parseCountList('a.ts\u00003\nb.ts\u00001\n')).toEqual([
      { path: 'a.ts', count: 3 },
      { path: 'b.ts', count: 1 },
    ]);
  });
});

describe('parseContentEvents', () => {
  const jsonl = [
    JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
    JSON.stringify({
      type: 'match',
      data: { path: { text: 'src/a.ts' }, lines: { text: 'hello match\n' }, line_number: 7, submatches: [{ match: { text: 'match' }, start: 6, end: 11 }] },
    }),
    JSON.stringify({
      type: 'context',
      data: { path: { text: 'src/a.ts' }, lines: { text: 'quiet line\n' }, line_number: 8 },
    }),
    JSON.stringify({
      type: 'match',
      data: { path: { text: 'src/b.ts' }, lines: { text: 'other hit\n' }, line_number: 2, submatches: [{ match: { text: 'hit' }, start: 6, end: 9 }] },
    }),
  ].join('\n');

  it('extracts match and context lines with paths, line numbers and text', () => {
    const lines = parseContentEvents(jsonl);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ path: 'src/a.ts', lineNumber: 7, isMatch: true, text: 'hello match' });
    expect(lines[1]).toMatchObject({ path: 'src/a.ts', lineNumber: 8, isMatch: false, text: 'quiet line' });
    expect(lines[2]).toMatchObject({ path: 'src/b.ts', lineNumber: 2, isMatch: true });
  });

  it('exposes only-matching slices for -o rendering', () => {
    const lines = parseContentEvents(jsonl);
    expect(lines[0].matches).toEqual(['match']);
    expect(lines[2].matches).toEqual(['hit']);
  });

  it('counts matches (not lines)', () => {
    expect(parseContentEvents(jsonl).filter((l) => l.isMatch)).toHaveLength(2);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it('applies the default head limit of 250', () => {
    const big = Array.from({ length: 300 }, (_, i) => i);
    const r = paginate(big);
    expect(r.items).toHaveLength(250);
    expect(r.appliedLimit).toBe(250);
  });

  it('treats limit 0 as unlimited', () => {
    const r = paginate(items, 0);
    expect(r.items).toHaveLength(10);
    expect(r.appliedLimit).toBeUndefined();
  });

  it('offsets before limiting', () => {
    const r = paginate(items, 3, 4);
    expect(r.items).toEqual([4, 5, 6]);
    expect(r.appliedOffset).toBe(4);
  });

  it('reports nothing applied for a small page-less result', () => {
    const r = paginate(items);
    expect(r.appliedLimit).toBeUndefined();
    expect(r.appliedOffset).toBeUndefined();
  });
});

describe('renderClip', () => {
  it('clips absurdly long lines so one minified file cannot flood context', () => {
    const r = renderClip('x'.repeat(600));
    expect(r.length).toBeLessThanOrEqual(501);
    expect(r.endsWith('…')).toBe(true);
  });
  it('passes normal lines through untouched', () => {
    expect(renderClip('const a = 1;')).toBe('const a = 1;');
  });
});
