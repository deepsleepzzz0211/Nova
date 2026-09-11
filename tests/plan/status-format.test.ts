import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fmtTokens,
  estimateCostUsd,
  contextUsage,
  readGitBranch,
} from '../../src/tui/status-format.js';

describe('status-format (tui-refactor 09)', () => {
  describe('fmtTokens', () => {
    it('compacts thousands and millions', () => {
      expect(fmtTokens(0)).toBe('0');
      expect(fmtTokens(999)).toBe('999');
      expect(fmtTokens(1234)).toBe('1.2k');
      expect(fmtTokens(2_500_000)).toBe('2.5M');
    });
  });

  describe('estimateCostUsd', () => {
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // USD / 1M

    it('returns null without a price', () => {
      expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 100 }, undefined)).toBeNull();
    });

    it('bills uncached input, cached read, cache write and output separately', () => {
      // input includes cached + write (normalized semantics)
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedInputTokens: 800_000,
        cacheWriteTokens: 100_000,
      };
      // uncached 100k * 3/1M = 0.3; cached 800k * 0.3/1M = 0.24;
      // write 100k * 3.75/1M = 0.375; output 100k * 15/1M = 1.5
      const total = estimateCostUsd(usage, cost);
      expect(total).toBeCloseTo(0.3 + 0.24 + 0.375 + 1.5, 6);
    });

    it('falls back to the input rate when cache prices are missing', () => {
      const usage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 200_000,
        cacheWriteTokens: 300_000,
      };
      const total = estimateCostUsd(usage, { input: 2, output: 5 });
      expect(total).toBeCloseTo((500_000 * 2) / 1_000_000 + (200_000 * 2) / 1_000_000 + (300_000 * 2) / 1_000_000, 6);
    });
  });

  describe('contextUsage', () => {
    it('computes the percentage and color thresholds', () => {
      expect(contextUsage(0, 100_000)).toEqual({ percent: 0, color: 'gray' });
      expect(contextUsage(50_000, 100_000).percent).toBe(50);
      expect(contextUsage(50_000, 100_000).color).toBe('gray');
      expect(contextUsage(750_000, 1_000_000).color).toBe('yellow');
      expect(contextUsage(900_000, 1_000_000).color).toBe('red');
    });

    it('handles a zero window without dividing by zero', () => {
      expect(contextUsage(100, 0)).toEqual({ percent: 0, color: 'gray' });
    });
  });

  describe('readGitBranch', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git-'));
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature-x\n');
    });
    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the branch from .git/HEAD', () => {
      expect(readGitBranch(dir)).toBe('feature-x');
    });

    it('returns a short sha for a detached HEAD', () => {
      const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git2-'));
      fs.mkdirSync(path.join(d2, '.git'));
      fs.writeFileSync(path.join(d2, '.git', 'HEAD'), 'a'.repeat(40) + '\n');
      expect(readGitBranch(d2)).toBe('aaaaaaaa');
      fs.rmSync(d2, { recursive: true, force: true });
    });

    it('returns null outside a repository', () => {
      const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git3-'));
      expect(readGitBranch(d3)).toBeNull();
      fs.rmSync(d3, { recursive: true, force: true });
    });
  });
});
