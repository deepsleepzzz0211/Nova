import { describe, it, expect } from 'vitest';
import {
  planOsSandbox,
  DEFAULT_WRITABLE_ROOTS,
  takeNotice,
  resetNoticeForTests,
  type OsSandboxProbe,
} from '../../src/permission/os-sandbox.js';

// Batch-B ticket 02 (G2 tier 2): OS-level sandbox configuration logic.
// Pure and injectable — the probe reports what the platform can actually
// do, planOsSandbox decides enable/fallback, and never lets a shell fail
// to start (fallback to tier 1 with an explicit notice).

const winOk: OsSandboxProbe = () => ({
  platform: 'win32',
  wrapperAvailable: true,
  reason: undefined,
});
const winMissing: OsSandboxProbe = () => ({
  platform: 'win32',
  wrapperAvailable: false,
  reason: 'csc.exe not found',
});
const posix: OsSandboxProbe = () => ({
  platform: 'linux',
  wrapperAvailable: false,
  reason: 'landlock not implemented on the darwin/linux leg',
});

describe('planOsSandbox', () => {
  it('off (default) is pure tier 1 with no probe call', () => {
    let probed = 0;
    const plan = planOsSandbox(
      { osLevel: 'off' },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      () => {
        probed++;
        return winOk();
      },
    );
    expect(probed).toBe(0);
    expect(plan.enabled).toBe(false);
    expect(plan.notice).toBeUndefined();
  });

  it('auto on win32 with a working wrapper enables and lists writable roots', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      winOk,
    );
    expect(plan.enabled).toBe(true);
    expect(plan.roots).toEqual(['D:/ws', 'C:/Users/x/.nova', 'C:/temp']);
    // Honest wording: at plan time only the probe passed; per-shell wrap
    // eligibility is still ahead. The notice must not claim OS refusals
    // are already in effect ("green-lighting itself" is the anti-pattern).
    expect(plan.notice).toMatch(/grants active/i);
    expect(plan.notice).toMatch(/degrade/i);
    expect(plan.notice).not.toMatch(/fail at the OS layer/);
  });

  it('auto on win32 without the wrapper falls back visibly, never blocks', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      winMissing,
    );
    expect(plan.enabled).toBe(false);
    expect(plan.notice).toMatch(/csc\.exe not found/);
    expect(plan.notice).toMatch(/tier-1/);
  });

  it('auto on POSIX emits the landlock-not-enabled stub once, tier 1 keeps running', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: '/home/u/ws', novaHome: '/home/u/.nova', tempDir: '/tmp' },
      posix,
    );
    expect(plan.enabled).toBe(false);
    expect(plan.notice).toMatch(/landlock/i);
    expect(plan.notice).toMatch(/tier-1/);
  });

  it('explicit auto never widens tier 1 roots: defaults stay workspace+home+temp', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      winOk,
    );
    const mapped = DEFAULT_WRITABLE_ROOTS.map((field) => {
      if (field === 'workspace') return 'D:/ws';
      if (field === 'novaHome') return 'C:/Users/x/.nova';
      return 'C:/temp';
    });
    expect(plan.roots).toEqual(mapped);
  });

  it('extra roots append after the defaults (order = widening audit trail)', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto', extraRoots: ['D:/build'] },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      winOk,
    );
    expect(plan.roots).toEqual(['D:/ws', 'C:/Users/x/.nova', 'C:/temp', 'D:/build']);
  });
});

describe('takeNotice (one-time surface)', () => {
  it('surfaces a plan notice exactly once per process', () => {
    resetNoticeForTests();
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' },
      winMissing,
    );
    expect(plan.enabled).toBe(false);
    expect(takeNotice(plan)).toContain('csc.exe not found');
    expect(takeNotice(plan)).toBeUndefined();
    resetNoticeForTests();
  });
});
