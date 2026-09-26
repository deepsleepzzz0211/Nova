import { describe, it, expect, vi } from 'vitest';
import { waitForRegistry } from '../../scripts/wait-for-registry.mjs';

// p1-p2 02/06: registry propagation wait with exponential backoff
// (report-14). The budget semantics of beta.2 must hold: visible-fast is
// visible-SOON (no fixed 15 s first sleep), and the total ceiling stays
// ~5 minutes so registry lag can never red an already-published release.
// The probe and the sleep are injected, so this is fully deterministic.

const okAfter = (visibleAt: number) => {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    return calls >= visibleAt;
  });
};

describe('waitForRegistry (p1-p2 06)', () => {
  it('returns immediately when the version is already visible', async () => {
    const probe = okAfter(1);
    const sleeps: number[] = [];
    const res = await waitForRegistry({ probe, sleep: async (ms) => { sleeps.push(ms); }, budgetMs: 300_000 });
    expect(res.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('backs off 1s,2s,4s,8s,16s then clamps at 16s', async () => {
    const probe = okAfter(7);
    const sleeps: number[] = [];
    const res = await waitForRegistry({ probe, sleep: async (ms) => { sleeps.push(ms); }, budgetMs: 300_000 });
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000]);
    expect(res.attempts).toBe(7);
  });

  it('gives up at the budget ceiling and reports not-visible', async () => {
    const probe = okAfter(999);
    let clock = 1_000;
    const res = await waitForRegistry({
      probe,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      budgetMs: 300_000,
    });
    expect(res.visible).toBe(false);
    expect(clock).toBeGreaterThan(300_000 + 1_000 - 16_000); // overslept at most one clamp
    expect(res.attempts).toBeGreaterThan(20);
  });

  it('probe errors count as not-visible attempts, not fatal', async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('npm view exited 1');
      return true;
    });
    const res = await waitForRegistry({ probe, sleep: async () => {}, budgetMs: 300_000 });
    expect(res.visible).toBe(true);
    expect(res.attempts).toBe(2);
  });
});
