import { describe, it, expect, vi } from 'vitest';
import {
  findCsc,
  probeWinWrap,
  ensureWrapper,
  grantRoots,
  restoreRoots,
  wrapInvocation,
  quoteWinArg,
  LOW_LABEL_SID,
  type WinWrapDeps,
} from '../../src/tools/win-wrap.js';
import { smokeProbe, createShellGate } from '../../src/tools/win-smoke.js';

// Batch-B ticket 02: the win32 realization layer for tier-2 OS sandbox.
// Side effects (fs + process runs) are injected; tests pin the decision
// table, the argv quoting, and the grant/restore lifecycle WITHOUT touching
// a real machine (real-machine proof is the live demo, per the ticket).

/** Path-normalizing in-memory deps (win32 path.join uses backslashes). */
function memDeps(overrides: Partial<WinWrapDeps> = {}): WinWrapDeps & {
  files: Map<string, string>;
  runs: Array<{ cmd: string; args: string[] }>;
} {
  const files = new Map<string, string>();
  const runs: Array<{ cmd: string; args: string[] }> = [];
  const norm = (p: string): string => p.split(String.fromCharCode(92)).join('/');
  return {
    files,
    runs,
    platform: 'win32',
    windir: 'C:/Windows',
    sandboxDir: 'C:/home/.nova/sandbox',
    existsFile: (p) => files.has(norm(p)) || p.includes('csc.exe'),
    writeFile: (p, data) => {
      files.set(norm(p), data);
    },
    removeFile: (p) => {
      files.delete(norm(p));
    },
    readFile: (p) => files.get(norm(p)),
    run: (cmd, args) => {
      runs.push({ cmd, args });
      // csc invocations materialize the -out: artifact
      const out = cmd.includes('csc.exe') ? args.find((a) => a.startsWith('-out:')) : undefined;
      if (out !== undefined) files.set(norm(out.slice(5)), 'exe');
      return { code: 0, stdout: '', stderr: '' };
    },
    ...overrides,
  };
}

describe('findCsc / probeWinWrap', () => {
  it('finds the preinstalled .NET Framework compiler on win32', () => {
    const d = memDeps();
    expect(findCsc(d)).toBe('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  });

  it('non-win32 never probes available (POSIX stub path)', () => {
    const d = memDeps({ platform: 'linux' });
    const p = probeWinWrap(d);
    expect(p.available).toBe(false);
    expect(p.reason).toMatch(/landlock/i);
  });

  it('missing csc reports a reason instead of throwing', () => {
    const d = memDeps({ existsFile: () => false });
    const p = probeWinWrap(d);
    expect(p.available).toBe(false);
    expect(p.reason).toMatch(/csc\.exe/);
  });
});

describe('ensureWrapper (compile once, cache in the home tree)', () => {
  it('compiles the wrapper when absent', () => {
    const d = memDeps();
    const r = ensureWrapper(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exePath).toContain('nova-wrap.exe');
    expect(d.runs.some((x) => x.cmd.includes('csc.exe'))).toBe(true);
  });

  it('reuses the cached exe without recompiling', () => {
    const d = memDeps();
    d.files.set('C:/home/.nova/sandbox/nova-wrap.exe', 'exe');
    const r = ensureWrapper(d);
    expect(r.ok).toBe(true);
    expect(d.runs).toHaveLength(0);
  });

  it('compile failure degrades visibly (caller falls back to tier 1)', () => {
    const d = memDeps({ run: () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    const r = ensureWrapper(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/compile/i);
  });
});

describe('grant/restore lifecycle', () => {
  it('grants the low label SID on every root and persists state', () => {
    const d = memDeps();
    const res = grantRoots(d, ['D:/ws', 'C:/home/.nova', 'C:/temp']);
    expect(res.ok).toBe(true);
    expect(d.runs).toHaveLength(3);
    for (const run of d.runs) {
      expect(run.cmd).toBe('icacls');
      expect(run.args).toContain(`/grant`);
      // Pinned verbatim: the trustee MUST be the Low mandatory-label SID
      // (S-1-16-4096). A wrong-but-syntactic SID (S-1-5-21-0-0-0-4096) is
      // rejected by icacls with ERROR_UNKNOWN_SID, failing every grant.
      expect(run.args.join(' ')).toContain('*S-1-16-4096:(OI)(CI)(M)');
      expect(LOW_LABEL_SID).toBe('S-1-16-4096');
    }
    expect(d.files.get('C:/home/.nova/sandbox/acl-state.json')).toContain('D:/ws');
  });

  it('a stale state file is restored BEFORE granting again (crash safety)', () => {
    const d = memDeps();
    d.files.set(
      'C:/home/.nova/sandbox/acl-state.json',
      JSON.stringify({ roots: ['D:/stale'] }),
    );
    grantRoots(d, ['D:/ws']);
    const remove = d.runs.find((x) => x.args.includes('/remove'));
    expect(remove?.args[0]).toBe('D:/stale');
    expect(d.runs.indexOf(remove!)).toBeLessThan(
      d.runs.findIndex((x) => x.args.includes('/grant')),
    );
  });

  it('restore removes grants and clears state; idempotent without state', () => {
    const d = memDeps();
    grantRoots(d, ['D:/ws']);
    d.runs.length = 0;
    restoreRoots(d);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]!.args).toContain('/remove');
    expect(d.files.has('C:/home/.nova/sandbox/acl-state.json')).toBe(false);
    expect(() => restoreRoots(d)).not.toThrow();
    expect(d.runs).toHaveLength(1);
  });

  it('a failing grant reports the failed roots (caller degrades whole tier)', () => {
    const d = memDeps({
      run: (_cmd, args) => (args[0] === 'C:/temp' ? { code: 5, stdout: '', stderr: 'denied' } : { code: 0, stdout: '', stderr: '' }),
    });
    const res = grantRoots(d, ['D:/ws', 'C:/temp']);
    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(['C:/temp']);
  });
});

describe('wrapInvocation argv assembly', () => {
  it('quotes arguments per MSVCRT rules', () => {
    expect(quoteWinArg('plain')).toBe('plain');
    expect(quoteWinArg('a b')).toBe('"a b"');
    expect(quoteWinArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWinArg('tab\there')).toBe('"tab\there"');
  });

  it('wraps a shell invocation as wrapper --cwd --cmd <line>', () => {
    const wrapped = wrapInvocation('C:/home/.nova/sandbox/nova-wrap.exe', {
      file: 'D:/Git/bin/bash.exe',
      args: ['-c', 'echo one'],
      stdinText: undefined,
    }, 'D:/ws');
    expect(wrapped.file).toBe('C:/home/.nova/sandbox/nova-wrap.exe');
    expect(wrapped.args.slice(0, 4)).toEqual(['--cwd', 'D:/ws', '--cmd', 'D:/Git/bin/bash.exe -c "echo one"']);
    expect(wrapped.stdinText).toBeUndefined();
  });

  it('stdin transport passes through unchanged (wrapper inherits the pipe)', () => {
    const wrapped = wrapInvocation('w.exe', {
      file: 'bash.exe',
      args: ['-c', 'X'],
      stdinText: 'real command',
    }, 'C:/w');
    expect(wrapped.stdinText).toBe('real command');
  });

  it('powershell-style args with embedded quotes survive reparse-safe quoting', () => {
    const wrapped = wrapInvocation('w.exe', {
      file: 'powershell.exe',
      args: ['-Command', "Write-Output 'a b'"],
      stdinText: undefined,
    }, 'C:/w');
    expect(wrapped.args[3]).toBe('powershell.exe -Command "Write-Output \'a b\'"');
  });
});

describe('smokeProbe (runtime reality check before trusting the wrap)', () => {
  it('passes when the wrapped shell echoes AND writes into a granted root', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        return { code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' };
      },
    });
    const r = smokeProbe(d, 'C:/home/.nova/sandbox/nova-wrap.exe', 'D:/Git/bin/bash.exe', 'D:/ws');
    expect(r.ok).toBe(true);
    // The write attempt lives in a materialized probe script (quoting an
    // inline node -e across cmd/bash/powershell is unresolvable; PowerShell
    // 5.1 has no && either). It must target the granted root.
    const probe = [...d.files.entries()].find(([p]) => p.includes('t2-probe.js'));
    expect(probe?.[1]).toContain('D:/ws/.nova-t2-probe');
    const last = d.runs[d.runs.length - 1]!;
    expect(last.cmd).toBe('C:/home/.nova/sandbox/nova-wrap.exe');
    expect(last.args.join(' ')).toContain('D:/Git/bin/bash.exe');
    expect(last.args.join(' ')).toContain('nova-t2-smoke');
    expect(last.args.join(' ')).toContain('t2-probe.js');
  });

  it('powershell gets a ;-separated probe (5.1 has no && operator)', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        return { code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' };
      },
    });
    smokeProbe(d, 'w.exe', 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'D:/ws');
    const line = d.runs[d.runs.length - 1]!.args.join(' ');
    expect(line).toContain('; node');
    expect(line).not.toContain('&&');
  });

  it('cmd.exe keeps the && separator', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        return { code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' };
      },
    });
    smokeProbe(d, 'w.exe', 'C:/Windows/System32/cmd.exe', 'D:/ws');
    const line = d.runs[d.runs.length - 1]!.args.join(' ');
    expect(line).toContain('&& node');
  });

  it('fails when the shell cannot start low (msys BaseNamedObjects fatal)', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        return {
          code: 1,
          stdout: '',
          stderr: 'bash: *** fatal error - NtCreateDirectoryObject(BaseNamedObjects): 0xC0000022',
        };
      },
    });
    const r = smokeProbe(d, 'w.exe', 'D:/Git/bin/bash.exe', 'D:/ws');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/NtCreateDirectoryObject/);
  });

  it('fails when the shell starts but cannot write the granted root (ML wall)', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        return { code: 0, stdout: 'nova-t2-smoke', stderr: '' };
      },
    });
    const r = smokeProbe(d, 'w.exe', 'bash.exe', 'D:/ws');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/write/i);
  });
});

describe('createShellGate (per-binary wrap eligibility, memoized)', () => {
  it('wraps shells that pass the probe and leaves failing ones unwrapped', () => {
    const d = memDeps({
      run: (cmd, args) => {
        d.runs.push({ cmd, args });
        const line = args.join(' ');
        return line.includes('good.exe')
          ? { code: 0, stdout: 'nova-t2-smoke nova-t2-write', stderr: '' }
          : { code: 1, stdout: '', stderr: 'fatal error - NtCreateDirectoryObject' };
      },
    });
    const gate = createShellGate(d, 'w.exe', 'D:/ws');
    expect(gate('C:/sh/good.exe')).toBe(true);
    expect(gate('D:/Git/bin/bash.exe')).toBe(false);
    const probes = d.runs.length;
    expect(gate('C:/sh/good.exe')).toBe(true); // memoized
    expect(gate('D:/Git/bin/bash.exe')).toBe(false);
    expect(d.runs.length).toBe(probes);
  });

  it('reports each degraded binary once via onDegrade (visible, not silent)', () => {
    const d = memDeps({
      run: () => ({ code: 1, stdout: '', stderr: 'fatal error - NtCreateDirectoryObject' }),
    });
    const seen: Array<[string, string]> = [];
    const gate = createShellGate(d, 'w.exe', 'D:/ws', (file, detail) => seen.push([file, detail]));
    expect(gate('D:/Git/bin/bash.exe')).toBe(false);
    expect(gate('D:/Git/bin/bash.exe')).toBe(false); // memoized: no second notice
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('D:/Git/bin/bash.exe');
    expect(seen[0]![1]).toMatch(/NtCreateDirectoryObject/);
  });
});
