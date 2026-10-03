import { describe, it, expect } from 'vitest';
import {
  planOsSandbox,
  createOsSandbox,
  DEFAULT_WRITABLE_ROOTS,
  type OsSandboxProbe,
  type OsSandboxPaths,
} from '../../src/tools/os-sandbox.js';
import type { WinWrapDeps } from '../../src/tools/win-wrap.js';
import type { SpawnInvocation } from '../../src/tools/shell-routing.js';

// Batch-B ticket 02 (G2 tier 2) + arch ticket 01: the OS sandbox is ONE deep
// module. createOsSandbox owns the full lifecycle (probe -> compile -> grant
// -> per-binary gate) behind { enabled, drainNotices, wrapSpawn, dispose };
// callers never sequence steps and notices drain exactly once per instance.
// planOsSandbox remains the internal pure decision layer (internal seam).

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

describe('planOsSandbox (internal decision layer)', () => {
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

  it('auto on POSIX emits the landlock-not-enabled stub, tier 1 keeps running', () => {
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      { workspaceRoot: '/home/u/ws', novaHome: '/home/u/.nova', tempDir: '/tmp' },
      posix,
    );
    expect(plan.enabled).toBe(false);
    expect(plan.notice).toMatch(/landlock/i);
    expect(plan.notice).toMatch(/tier-1/);
  });

  it('auto never widens the roots: they are exactly the DEFAULT_WRITABLE_ROOTS mapping', () => {
    const paths = { workspaceRoot: 'D:/ws', novaHome: 'C:/Users/x/.nova', tempDir: 'C:/temp' };
    const plan = planOsSandbox({ osLevel: 'auto' }, paths, winOk);
    expect(plan.roots).toEqual(DEFAULT_WRITABLE_ROOTS.map((field) => paths[field]));
  });
});

// --- deep-module interface tests -------------------------------------------

const paths: OsSandboxPaths = {
  workspaceRoot: 'D:/ws',
  novaHome: 'C:/home/.nova',
  tempDir: 'C:/temp',
};

interface MemDeps extends WinWrapDeps {
  files: Map<string, string>;
  runs: Array<{ cmd: string; args: string[] }>;
  probeStdoutFor: (line: string) => string;
}

/** In-memory machine: fake csc/icacls/wrapper keyed on the command line. */
function memSandboxDeps(overrides: {
  cscMissing?: boolean;
  grantFailRoot?: string;
  /** stdout the wrapped probe returns for a --cmd line (default: both markers). */
  probe?: (line: string) => { code: number; stdout: string; stderr: string };
} = {}): MemDeps {
  const files = new Map<string, string>();
  const runs: Array<{ cmd: string; args: string[] }> = [];
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const probe = overrides.probe ?? (() => ({ code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' }));
  const existsFile = (p: string): boolean => {
    if (p.includes('csc.exe')) return !overrides.cscMissing;
    return files.has(norm(p));
  };
  const run = (cmd: string, args: string[]): { code: number; stdout: string; stderr: string } => {
    runs.push({ cmd, args });
    if (cmd.includes('csc.exe')) {
      const out = args.find((a) => a.startsWith('-out:'));
      if (out !== undefined) files.set(norm(out.slice(5)), 'exe');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'icacls') {
      if (overrides.grantFailRoot !== undefined && args[0] === overrides.grantFailRoot) {
        return { code: 5, stdout: '', stderr: 'Access is denied' };
      }
      return { code: 0, stdout: 'success', stderr: '' };
    }
    if (cmd.includes('nova-wrap.exe')) return probe(args.join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    platform: 'win32',
    windir: 'C:/Windows',
    sandboxDir: 'C:/home/.nova/sandbox',
    tempDir: 'C:/temp',
    existsFile,
    writeFile: (p, data) => {
      files.set(norm(p), data);
    },
    removeFile: (p) => {
      files.delete(norm(p));
    },
    readFile: (p) => files.get(norm(p)),
    run,
    files,
    runs,
    probeStdoutFor: (line) => probe(line).stdout,
  };
}

const bashInv: SpawnInvocation = { file: 'D:/Git/bin/bash.exe', args: ['-c', 'echo hi'], stdinText: undefined };

describe('createOsSandbox (the deep interface)', () => {
  it('off: disabled, identity wrap, no notices, no side effects', () => {
    const d = memSandboxDeps();
    const sb = createOsSandbox({ osLevel: 'off', paths, deps: d });
    expect(sb.enabled).toBe(false);
    expect(d.runs).toHaveLength(0);
    expect(sb.drainNotices()).toEqual([]);
    expect(sb.wrapSpawn(bashInv, 'D:/ws')).toBe(bashInv);
    expect(() => sb.dispose()).not.toThrow();
    expect(d.runs).toHaveLength(0);
  });

  it('auto+healthy machine: construction completes ALL prep (csc/compile/grant) up front; enabled with one honest notice', () => {
    const d = memSandboxDeps();
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: d });
    // Prep before any wrap call: probe/compile/grant already ran (child
    // timeouts are NEVER spent on setup — the ZCode revert bug class).
    expect(d.runs.some((r) => r.cmd.includes('csc.exe'))).toBe(true);
    expect(d.runs.some((r) => r.cmd === 'icacls')).toBe(true);
    expect(sb.enabled).toBe(true);
    const notices = sb.drainNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/grants active on 3 roots/);
    expect(sb.drainNotices()).toEqual([]); // drained exactly once
  });

  it('eligible shell wraps at the spawn call; the wrapper exe carries cwd+cmd', () => {
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: memSandboxDeps() });
    const wrapped = sb.wrapSpawn(bashInv, 'D:/ws');
    expect(wrapped.file).toContain('nova-wrap.exe');
    expect(wrapped.args.slice(0, 2)).toEqual(['--cwd', 'D:/ws']);
    expect(wrapped.args.join(' ')).toContain('D:/Git/bin/bash.exe');
  });

  it('ineligible binary degrades VISIBLY and stays unwrapped (per-binary gate)', () => {
    const d = memSandboxDeps({
      probe: (line) =>
        line.includes('powershell')
          ? { code: 0, stdout: 'nova-t2-smoke', stderr: '' } // started, write refused
          : { code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' },
    });
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: d });
    const psInv: SpawnInvocation = { file: 'C:/Windows/powershell.exe', args: ['-c', 'x'], stdinText: undefined };
    expect(sb.wrapSpawn(psInv, 'D:/ws')).toBe(psInv); // not wrapped
    const notices = sb.drainNotices().join('\n');
    expect(notices).toMatch(/grants active/);
    expect(notices).toMatch(/not wrapping powershell\.exe .*integrity label/i);
    expect(sb.wrapSpawn(psInv, 'D:/ws')).toBe(psInv); // memoized, no second notice
    expect(sb.drainNotices()).toEqual([]);
    expect(sb.wrapSpawn(bashInv, 'D:/ws').file).toContain('nova-wrap.exe'); // bash still wraps
  });

  it('missing csc: disabled with the fallback notice, no grants ever issued', () => {
    const d = memSandboxDeps({ cscMissing: true });
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: d });
    expect(sb.enabled).toBe(false);
    expect(sb.drainNotices()[0]).toMatch(/csc\.exe.*not found/);
    expect(d.runs.some((r) => r.cmd === 'icacls')).toBe(false);
    expect(sb.wrapSpawn(bashInv, 'D:/ws')).toBe(bashInv);
  });

  it('grant failure: whole tier disabled, applied grants rolled back, honest notice', () => {
    const d = memSandboxDeps({ grantFailRoot: 'C:/temp' });
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: d });
    expect(sb.enabled).toBe(false);
    expect(sb.drainNotices()[0]).toMatch(/could not activate .*grant failed on: C:\/temp/);
    // Rollback removed the roots that DID grant (D:/ws, nova home).
    const removes = d.runs.filter((r) => r.cmd === 'icacls' && r.args.includes('/remove'));
    expect(removes.some((r) => r.args[0] === 'D:/ws')).toBe(true);
    expect(sb.wrapSpawn(bashInv, 'D:/ws')).toBe(bashInv);
    expect(() => sb.dispose()).not.toThrow();
  });

  it('dispose restores grants once and clears state; repeat calls are inert', () => {
    const d = memSandboxDeps();
    const sb = createOsSandbox({ osLevel: 'auto', paths, deps: d });
    d.runs.length = 0;
    sb.dispose();
    expect(d.runs.some((r) => r.cmd === 'icacls' && r.args.includes('/remove'))).toBe(true);
    expect(d.files.has('C:/home/.nova/sandbox/acl-state.json')).toBe(false);
    const n = d.runs.length;
    sb.dispose();
    expect(d.runs).toHaveLength(n);
  });

  it('stale state from a crash is restored BEFORE re-granting', () => {
    const d = memSandboxDeps();
    d.files.set('C:/home/.nova/sandbox/acl-state.json', JSON.stringify({ roots: ['D:/stale'] }));
    createOsSandbox({ osLevel: 'auto', paths, deps: d });
    const removes = d.runs.findIndex((r) => r.cmd === 'icacls' && r.args.includes('/remove'));
    const grants = d.runs.findIndex((r) => r.cmd === 'icacls' && r.args.includes('/grant'));
    expect(removes).toBeLessThan(grants);
    expect(d.runs[removes]!.args[0]).toBe('D:/stale');
  });
});
