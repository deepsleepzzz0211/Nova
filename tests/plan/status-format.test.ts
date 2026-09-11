import { describe, it, expect } from 'vitest';
import { fmtTokens, estimateCostUsd, contextUsage, workingBorderColor } from '../../src/tui/status-format.js';

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

  describe('workingBorderColor', () => {
    it('maps the working states to distinct colors', () => {
      expect(workingBorderColor('idle')).toBe('cyan');
      expect(workingBorderColor('streaming')).toBe('yellow');
      expect(workingBorderColor('thinking')).toBe('magenta');
    });
  });
});
