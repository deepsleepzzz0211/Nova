import { describe, it, expect } from 'vitest';
import { summarizeShellPlan, type ShellPlan } from '../../src/tools/shell-routing.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import type { Tool } from '../../src/tools/types.js';

// windows-shell ticket 02: the model must be told WHICH interpreter executes
// its commands. Pure formatter + prompt rendering; wiring stays in the DI
// root so agent/ never value-depends on tools/.

const noTools: Tool[] = [];

describe('summarizeShellPlan', () => {
  it('Git Bash plan reads as POSIX-compatible with its path', () => {
    const plan: ShellPlan = { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', transport: 'argv', label: 'Git Bash' };
    const s = summarizeShellPlan(plan);
    expect(s.shell).toMatch(/Git Bash/);
    expect(s.shell).toContain('POSIX');
    expect(s.note).toBeUndefined();
  });
  it('custom NOVA_SHELL path reports the path verbatim', () => {
    const plan: ShellPlan = { kind: 'bash', path: 'D:\\tools\\bash.exe', transport: 'argv', label: 'custom (D:\\tools\\bash.exe)' };
    expect(summarizeShellPlan(plan).shell).toContain('D:/tools/bash.exe');
  });
  it('cmd fallback carries a syntax-warning note', () => {
    const s = summarizeShellPlan({ kind: 'cmd', label: 'cmd.exe (fallback)', fallbackNotice: 'install Git for Windows' });
    expect(s.shell).toContain('cmd.exe');
    expect(s.note).toMatch(/POSIX|bash/i);
  });
  it('cmd via explicit escape hatch gets no scary note', () => {
    const s = summarizeShellPlan({ kind: 'cmd', label: 'cmd.exe (NOVA_SHELL=cmd)' });
    expect(s.shell).toContain('cmd.exe');
    expect(s.note).toBeUndefined();
  });
});

describe('system prompt environment section', () => {
  const baseEnv = { workingDirectory: '/work', platform: 'win32', isGitRepo: false };

  it('renders Shell and PowerShell lines when facts are provided', () => {
    const prompt = buildSystemPrompt(noTools, [], {
      environment: { ...baseEnv, shell: 'Git Bash (POSIX-compatible)', powershell: 'pwsh 7 available' },
    });
    expect(prompt).toContain('Shell: Git Bash (POSIX-compatible)');
    expect(prompt).toContain('PowerShell: pwsh 7 available');
  });

  it('renders the fallback note when present', () => {
    const prompt = buildSystemPrompt(noTools, [], {
      environment: { ...baseEnv, shell: 'cmd.exe', shellNote: 'POSIX syntax may fail; install Git Bash' },
    });
    expect(prompt).toContain('cmd.exe');
    expect(prompt).toContain('POSIX syntax may fail');
  });

  it('omits the lines entirely when facts are absent (POSIX default)', () => {
    const prompt = buildSystemPrompt(noTools, [], { environment: { ...baseEnv, platform: 'linux' } });
    expect(prompt).not.toContain('Shell:');
    expect(prompt).not.toContain('PowerShell:');
  });

  it('is byte-stable across builds with the same facts (frozen-prompt discipline)', () => {
    const opts = { environment: { ...baseEnv, shell: 'Git Bash (POSIX-compatible)', powershell: 'not found' } };
    expect(buildSystemPrompt(noTools, [], opts)).toBe(buildSystemPrompt(noTools, [], opts));
  });
});
