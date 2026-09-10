import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SLASH_COMMANDS,
  detectCompletion,
  completeCommands,
  fuzzyMatchFiles,
  buildFileIndex,
} from '../../src/tui/completions.js';

describe('completions (tui-refactor 03)', () => {
  describe('detectCompletion', () => {
    it('detects a slash command at position 0', () => {
      const c = detectCompletion('/mo', 3);
      expect(c).toEqual({ kind: 'slash', query: 'mo', tokenStart: 0 });
    });

    it('detects the bare slash', () => {
      const c = detectCompletion('/', 1);
      expect(c).toEqual({ kind: 'slash', query: '', tokenStart: 0 });
    });

    it('rejects slash not at position 0', () => {
      expect(detectCompletion('hi /mo', 6)).toBeNull();
    });

    it('rejects slash with whitespace before the cursor', () => {
      expect(detectCompletion('/mo del', 7)).toBeNull();
    });

    it('detects an @ file token at line start', () => {
      const c = detectCompletion('@src/ma', 7);
      expect(c).toEqual({ kind: 'file', query: 'src/ma', tokenStart: 0 });
    });

    it('detects an @ file token after whitespace', () => {
      const c = detectCompletion('look at @read', 13);
      expect(c).toEqual({ kind: 'file', query: 'read', tokenStart: 8 });
    });

    it('rejects @ preceded by a non-space char (email-like)', () => {
      expect(detectCompletion('foo@ba', 6)).toBeNull();
    });

    it('rejects @ query containing whitespace', () => {
      expect(detectCompletion('@a b', 4)).toBeNull();
    });

    it('returns null with no trigger', () => {
      expect(detectCompletion('plain text', 5)).toBeNull();
    });
  });

  describe('completeCommands', () => {
    it('prefix-matches case-insensitively', () => {
      const r = completeCommands('U');
      expect(r.map((c) => c.name)).toEqual(['undo', 'update']);
    });

    it('empty query returns all', () => {
      expect(completeCommands('').length).toBe(SLASH_COMMANDS.length);
    });
  });

  describe('fuzzyMatchFiles', () => {
    const files = [
      'src/tui/InputBar.tsx',
      'src/tui/editor-state.ts',
      'src/agent/loop.ts',
      'tests/plan/input-bar.test.tsx',
      'README.md',
    ];

    it('empty query returns the first files (as given)', () => {
      expect(fuzzyMatchFiles(files, '')).toEqual(files.slice(0, 5));
    });

    it('matches a subsequence case-insensitively', () => {
      const r = fuzzyMatchFiles(files, 'inpbar');
      expect(r).toContain('src/tui/InputBar.tsx');
      expect(r).not.toContain('src/agent/loop.ts');
    });

    it('prefers boundary (path separator) matches', () => {
      const r = fuzzyMatchFiles(files, 'tui');
      expect(r[0]).toContain('src/tui/');
    });

    it('respects the limit', () => {
      const many = Array.from({ length: 30 }, (_, i) => `dir/file${i}.txt`);
      expect(fuzzyMatchFiles(many, 'file').length).toBeLessThanOrEqual(8);
    });
  });

  describe('buildFileIndex', () => {
    let root: string;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-idx-'));
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.mkdirSync(path.join(root, '.git'));
      fs.writeFileSync(path.join(root, 'README.md'), 'x');
      fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'x');
      fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');
      fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
    });
    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('walks files, skipping ignored dirs, with forward slashes', async () => {
      const files = await buildFileIndex(root);
      expect(files).toContain('README.md');
      expect(files).toContain('src/main.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.includes('.git'))).toBe(false);
      expect(files.every((f) => !f.includes('\\'))).toBe(true);
    });

    it('caps the index size', async () => {
      const big = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-big-'));
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
      const files = await buildFileIndex(big, { maxFiles: 10 });
      expect(files.length).toBeLessThanOrEqual(10);
      fs.rmSync(big, { recursive: true, force: true });
    });
  });
});
