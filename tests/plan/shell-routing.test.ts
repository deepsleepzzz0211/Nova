import { describe, it, expect } from 'vitest';
import {
  isLegacyWslBash,
  resolveShell,
  buildSpawnInvocation,
  ShellRouteError,
  type ShellPlan,
  type ShellProbe,
} from '../../src/tools/shell-routing.js';

type BashPlan = Extract<ShellPlan, { kind: 'bash' }>;

function mustBash(plan: ShellPlan): BashPlan {
  if (plan.kind !== 'bash') throw new Error(`expected bash plan, got ${plan.kind}`);
  return plan;
}

// Pure seams of the shell routing (windows-shell ticket 01). The probe and
// env are injected so every resolution branch is testable on any platform.

function probe(opts: { exists?: string[]; which?: Record<string, string | null> }): ShellProbe {
  return {
    exists: (p) => (opts.exists ?? []).includes(p),
    which: (exe) => (opts.which ?? {})[exe] ?? null,
  };
}

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
};

describe('isLegacyWslBash', () => {
  it('matches System32 and Sysnative bash.exe case-insensitively', () => {
    expect(isLegacyWslBash('C:\\Windows\\System32\\bash.exe')).toBe(true);
    expect(isLegacyWslBash('c:\\windows\\sysnative\\bash.exe')).toBe(true);
  });
  it('does not match Git Bash or PATH bash', () => {
    expect(isLegacyWslBash('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
    expect(isLegacyWslBash('D:\\Git\\bin\\bash.exe')).toBe(false);
    expect(isLegacyWslBash('C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });
  it('does not match same-named files outside the windows directories', () => {
    expect(isLegacyWslBash('E:\\Tools\\System32\\bash.exe')).toBe(false);
  });
});

describe('resolveShell (win32 resolution order)', () => {
  it('NOVA_SHELL explicit existing path wins and is flagged custom', () => {
    const plan = mustBash(resolveShell(
      { platform: 'win32', env: { NOVA_SHELL: 'C:\\cygwin64\\bin\\bash.exe' }, probe: probe({ exists: ['C:\\cygwin64\\bin\\bash.exe'] }) },
    ));
    expect(plan.path).toBe('C:\\cygwin64\\bin\\bash.exe');
    expect(plan.transport).toBe('argv');
  });
  it('NOVA_SHELL pointing at a missing path throws instead of silently degrading', () => {
    expect(() =>
      resolveShell({ platform: 'win32', env: { NOVA_SHELL: 'D:\\nope\\bash.exe' }, probe: probe({}) }),
    ).toThrow(ShellRouteError);
  });
  it('NOVA_SHELL=cmd is the escape hatch', () => {
    const plan = resolveShell({ platform: 'win32', env: { NOVA_SHELL: 'cmd' }, probe: probe({}) });
    expect(plan.kind).toBe('cmd');
  });
  it('legacy WSL bash via NOVA_SHELL switches to stdin transport', () => {
    const plan = resolveShell(
      { platform: 'win32', env: { NOVA_SHELL: 'C:\\Windows\\System32\\bash.exe' }, probe: probe({ exists: ['C:\\Windows\\System32\\bash.exe'] }) },
    );
    expect(plan).toMatchObject({ kind: 'bash', transport: 'stdin' });
  });
  it('Git Bash in ProgramFiles beats PATH', () => {
    const plan = mustBash(resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      probe: probe({
        exists: ['C:\\Program Files\\Git\\bin\\bash.exe'],
        which: { 'bash.exe': 'D:\\other\\bash.exe' },
      }),
    }));
    expect(plan.path).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });
  it('falls back to bash.exe on PATH when Git Bash is absent', () => {
    const plan = mustBash(resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      probe: probe({ which: { 'bash.exe': 'D:\\Git\\bin\\bash.exe' } }),
    }));
    expect(plan.path).toBe('D:\\Git\\bin\\bash.exe');
  });
  it('PATH-found legacy WSL bash uses stdin transport', () => {
    const plan = resolveShell({
      platform: 'win32',
      env: WIN_ENV,
      probe: probe({ which: { 'bash.exe': 'C:\\Windows\\System32\\bash.exe' } }),
    });
    expect(plan).toMatchObject({ kind: 'bash', transport: 'stdin' });
  });
  it('everything missing -> cmd fallback carrying a one-time notice', () => {
    const plan = resolveShell({ platform: 'win32', env: WIN_ENV, probe: probe({}) });
    expect(plan.kind).toBe('cmd');
    expect(plan.fallbackNotice).toMatch(/Git for Windows/i);
  });
});

describe('resolveShell (POSIX stays untouched)', () => {
  it('plain bash -c plan regardless of probe', () => {
    const plan = resolveShell({ platform: 'linux', env: {}, probe: probe({}) });
    expect(plan).toMatchObject({ kind: 'bash', path: 'bash', transport: 'argv' });
  });
  it('NOVA_SHELL=cmd does not apply off Windows (no cmd plan)', () => {
    const plan = resolveShell({ platform: 'darwin', env: { NOVA_SHELL: 'cmd' }, probe: probe({}) });
    expect(plan.kind).toBe('bash');
  });
});

describe('buildSpawnInvocation', () => {
  it('bash argv form: bash -c <command> (never via Node shell option)', () => {
    const inv = buildSpawnInvocation({ kind: 'bash', path: 'D:\\Git\\bin\\bash.exe', transport: 'argv', label: 'Git Bash' }, 'echo hi');
    expect(inv).toEqual({ file: 'D:\\Git\\bin\\bash.exe', args: ['-c', 'echo hi'], stdinText: undefined });
  });
  it('bash stdin form: bash -s with the command piped in', () => {
    const inv = buildSpawnInvocation({ kind: 'bash', path: 'C:\\Windows\\System32\\bash.exe', transport: 'stdin', label: 'bash' }, 'echo hi');
    expect(inv.file).toBe('C:\\Windows\\System32\\bash.exe');
    expect(inv.args).toEqual(['-s']);
    expect(inv.stdinText).toContain('echo hi');
  });
  it('cmd form: cmd.exe /d /s /c <command>', () => {
    const inv = buildSpawnInvocation({ kind: 'cmd', label: 'cmd.exe' }, 'dir');
    expect(inv.file).toBe('cmd.exe');
    expect(inv.args).toEqual(['/d', '/s', '/c', 'dir']);
  });
});
