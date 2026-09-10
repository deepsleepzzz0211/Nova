import { describe, it, expect } from 'vitest';
import {
  SPINNER_FRAMES,
  spinnerFrame,
  summarizeCall,
  foldLines,
} from '../../src/tui/tool-summary.js';

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
      expect(summarizeCall('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la');
    });

    it('path-like tools show the path', () => {
      expect(summarizeCall('read', JSON.stringify({ path: 'a/b.txt' }))).toBe('a/b.txt');
      expect(summarizeCall('write', JSON.stringify({ path: 'a/b.txt' }))).toBe('a/b.txt');
      expect(summarizeCall('edit', JSON.stringify({ file_path: 'c.txt' }))).toBe('c.txt');
    });

    it('falls back to compact JSON capped at 80 chars', () => {
      const long = 'x'.repeat(200);
      const r = summarizeCall('other', JSON.stringify({ a: long }));
      expect(r.length).toBeLessThanOrEqual(83); // 80 + ellipsis
      expect(r.startsWith('{"a":"xxx')).toBe(true);
      expect(r.endsWith('...')).toBe(true);
    });

    it('handles unparseable args by echoing raw (capped)', () => {
      const r = summarizeCall('x', 'not json but quite long '.repeat(10));
      expect(r.length).toBeLessThanOrEqual(83);
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
