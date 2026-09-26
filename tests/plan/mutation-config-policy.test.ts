import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

// p1-p2 04 (report-12): thresholds live in ONE place (stryker.config.json);
// scripts/mutation-baseline.json is a pure snapshot. These assertions kill
// the "change one file, forget the other" failure mode — and pin that the
// recorded score actually satisfies the gate that will enforce it.

const stryker = JSON.parse(fs.readFileSync('stryker.config.json', 'utf-8')) as {
  thresholds: { high: number; low: number; break: number };
};
const baseline = JSON.parse(fs.readFileSync('scripts/mutation-baseline.json', 'utf-8')) as {
  thresholds?: unknown;
  scoreTotal: number;
  scoreCovered: number;
};

describe('mutation ratchet config policy (p1-p2 04)', () => {
  it('baseline carries NO threshold copy (single source of truth)', () => {
    expect(baseline.thresholds).toBeUndefined();
  });

  it('recorded snapshot satisfies the live break gate', () => {
    expect(baseline.scoreTotal).toBeGreaterThanOrEqual(stryker.thresholds.break);
  });

  it('snapshot fields are coherent (covered >= total, both percentages)', () => {
    expect(baseline.scoreCovered).toBeGreaterThanOrEqual(baseline.scoreTotal);
    for (const s of [baseline.scoreTotal, baseline.scoreCovered]) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('thresholds themselves are ordered (break <= low <= high)', () => {
    const { high, low, break: brk } = stryker.thresholds;
    expect(brk).toBeLessThanOrEqual(low);
    expect(low).toBeLessThanOrEqual(high);
  });
});
