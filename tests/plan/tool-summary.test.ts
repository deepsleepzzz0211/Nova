import { describe, it, expect } from 'vitest';
import {
  STATUS_STYLE,
  formatArgs,
  SPINNER_FRAMES,
  spinnerFrame,
  summarizeCall,
  foldLines,
} from '../../src/tui/tool-summary.js';

function kindOf(name: string): 'command' | 'path' | undefined {
  if (name === 'bash') return 'command';
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return 'path';
  return undefined;
}

describe('tool-summary (tui-refactor 05)', () => {
  describe('spinner', () => {
    it('has braille frames and cycles deterministically', () => {
      expect(SPINNER_FRAMES.length).toBeGreaterThan(3);
      expect(spinnerCycles()).toBe(true);
      function spinnerCycles(): boolean {
        const n = SPINNER_FRAMES.length;
        return SPINNER_FRAMES.every((f, i) => spinnerFrame(i) === f && spinnerFrame(i + n) === f);
      }
    });
  });

  describe('summarizeCall', () => {
    it('bash shows the command string', () => {
      expect(summarizeCall('bash', JSON.stringify({ command: 'ls -la' }), kindOf)).toBe('ls -la');
    });

    it('path-like tools show the path', () => {
      expect(summarizeCall('read_file', JSON.stringify({ path: 'a/b.txt' }), kindOf)).toBe('a/b.txt');
      expect(summarizeCall('write_file', JSON.stringify({ path: 'a/b.txt' }), kindOf)).toBe('a/b.txt');
      expect(summarizeCall('read_file', JSON.stringify({ path: 'c.txt' }), kindOf)).toBe('c.txt');
    });

    it('falls back to compact JSON capped at 200 chars (review: approval visibility)', () => {
      const long = 'x'.repeat(400);
      const r = summarizeCall('other', JSON.stringify({ a: long }), kindOf);
      expect(r.length).toBeLessThanOrEqual(203); // 200 + ellipsis
      expect(r.startsWith('{"a":"xxx')).toBe(true);
      expect(r.endsWith('...')).toBe(true);
    });

    it('handles unparseable args by echoing raw (capped)', () => {
      const r = summarizeCall('x', 'not json but quite long '.repeat(20), kindOf);
      expect(r.length).toBeLessThanOrEqual(203);
    });
  });

  describe('foldLines', () => {
    it('keeps short text whole', () => {
      const r = foldLines('a\nb', 20);
      expect(r.text).toBe('a\nb');
      expect(r.hidden).toBe(0);
    });

    it('folds beyond max with the hidden count', () => {
      const text = Array.from({ length: 30 }, (_, i) => `L${i}`).join('\n');
      const r = foldLines(text, 10);
      expect(r.text).toBe('L0\nL1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\n... (20 more lines)');
      expect(r.hidden).toBe(20);
    });
  });
});

describe('status style table and arg formatting (review fixes)', () => {
  it('exposes one icon/color per status', () => {
    expect(STATUS_STYLE.pending).toEqual({ icon: '⚠', color: 'yellow' });
    expect(STATUS_STYLE.done).toEqual({ icon: '✓', color: 'green' });
    expect(STATUS_STYLE.error).toEqual({ icon: '✗', color: 'red' });
    expect(STATUS_STYLE.running.color).toBe('yellow');
  });

  it('formats parsed args pretty-printed and falls back to raw', () => {
    expect(formatArgs('{"a":1}', { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatArgs('not json', null)).toBe('not json');
  });
});
