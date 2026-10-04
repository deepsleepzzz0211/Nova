import { describe, it, expect, vi } from 'vitest';
import { createShellLauncher, unsandboxed, type SandboxView } from '../../src/tools/shell-launcher.js';
import * as os from 'node:os';

// Arch ticket 02: ONE launcher seam spawns every shell child (foreground
// run, background start, hook capture, interactive session). arch2 ticket A1:
// the seam now takes the SANDBOX itself, not a bare wrap function — applying
// the wrap, draining degrade notices, and reporting them is launcher-owned,
// so no composition root can forget the drain ordering. An unwrapped path
// (declarative hooks, test defaults) is the explicit `unsandboxed` adapter.
// Tests cross the interface with real tiny node processes.

const cwd = os.tmpdir();
const nodeInv = (js: string, ...args: string[]): import('../../src/tools/shell-routing.js').SpawnInvocation => ({
  file: process.execPath,
  args: ['-e', js, ...args],
  stdinText: undefined,
});

/**
 * Sandbox stub mirroring the real OsSandbox notice mechanics: wraps
 * accumulate pending notices (one round per wrap from `rounds`), and
 * drainNotices empties what has accumulated. `initial` seeds notices that
 * exist before any wrap (grants-active / fallback style).
 */
function stubSandbox(opts: { rounds?: string[][]; initial?: string[] } = {}): SandboxView & { seen: string[] } {
  const seen: string[] = [];
  const rounds = opts.rounds ?? [];
  let pending = opts.initial ?? [];
  return {
    seen,
    wrapSpawn(inv, _cwd) {
      seen.push(inv.file);
      pending = [...pending, ...(rounds.shift() ?? [])];
      return inv;
    },
    drainNotices() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

describe('ShellLauncher.run', () => {
  it('collects merged output and exit code through the sandbox wrap point', async () => {
    const sandbox = stubSandbox();
    const launcher = createShellLauncher({ sandbox });
    const r = await launcher.run(nodeInv('console.log("hi"); console.error("oops")'), {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    expect(r.content).toContain('hi');
    expect(r.content).toContain('oops');
    expect(r.exitCode).toBe(0);
    expect(sandbox.seen).toEqual([process.execPath]); // wrapped exactly once
  });

  it('timeout ladder: SIGTERM then the run resolves non-zero (sleep cannot outlive it)', async () => {
    const launcher = createShellLauncher({ sandbox: unsandboxed });
    const started = Date.now();
    const r = await launcher.run(nodeInv('setTimeout(() => {}, 30_000)'), {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 400,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.exitCode).not.toBe(0);
  });
});

describe('ShellLauncher.capture (hooks shape)', () => {
  it('keeps stdout/stderr SEPARATE, feeds stdin, returns timedOut', async () => {
    const launcher = createShellLauncher({ sandbox: unsandboxed });
    const r = await launcher.capture(
      { ...nodeInv('let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log("OUT:"+s);console.error("ERRSIDE");})'), stdinText: 'payload' },
      { cwd, timeoutMs: 10_000 },
    );
    expect(r.stdout).toContain('OUT:payload');
    expect(r.stderr).toContain('ERRSIDE');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);

    const late = await launcher.capture(nodeInv('setTimeout(() => {}, 30_000)'), { cwd, timeoutMs: 300 });
    expect(late.timedOut).toBe(true);
  });

  it('the sandbox is applied here too — no un-wrapped side door', async () => {
    const sandbox = stubSandbox();
    const launcher = createShellLauncher({ sandbox });
    await launcher.capture(nodeInv('console.log(1)'), { cwd, timeoutMs: 5_000 });
    expect(sandbox.seen).toHaveLength(1);
  });
});

describe('ShellLauncher.start (background jobs)', () => {
  it('returns a JobHandle with pid and streaming stdout', async () => {
    const launcher = createShellLauncher({ sandbox: unsandboxed });
    const handle = launcher.start(nodeInv('let n=0;const t=setInterval(()=>{console.log("TICK-"+n++)},30);setTimeout(()=>clearInterval(t),900)'), { cwd });
    expect(typeof handle.pid).toBe('number');
    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      handle.stdout?.on('data', (d: Buffer) => {
        chunks.push(d.toString());
        if (chunks.join('').includes('TICK-1')) resolve();
      });
      setTimeout(resolve, 3_000);
    });
    expect(chunks.join('')).toContain('TICK-0');
    handle.kill('SIGKILL');
  });

  it('start goes through the sandbox (children cannot escape via background)', () => {
    const sandbox = stubSandbox();
    const launcher = createShellLauncher({ sandbox });
    const handle = launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd });
    expect(sandbox.seen).toHaveLength(1);
    handle.kill('SIGKILL');
  });
});

describe('ShellLauncher.interactive (session shells)', () => {
  it('pipes stdin->stdout through the wrapped child', async () => {
    const sandbox = stubSandbox();
    const launcher = createShellLauncher({ sandbox });
    const proc = launcher.interactive(nodeInv('process.stdin.pipe(process.stdout)'), { cwd });
    const out: string[] = [];
    proc.stdout!.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stdin!.end('through-me\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(out.join('')).toContain('through-me');
    expect(sandbox.seen).toEqual([process.execPath]);
    proc.kill('SIGKILL');
  });

  it('close/error listeners attachable (EventEmitter contract for ShellProc)', () => {
    const launcher = createShellLauncher({ sandbox: unsandboxed });
    const proc = launcher.interactive(nodeInv('process.exitCode=0'), { cwd });
    let closed = false;
    proc.on('close', () => {
      closed = true;
    });
    expect(typeof proc.kill).toBe('function');
    void closed;
    proc.kill('SIGKILL');
  });
});

describe('degrade-notice plumbing (arch2 A1, launcher-owned)', () => {
  it('notices already pending at construction are surfaced WITHOUT any spawn', () => {
    // Startup visibility: the grants-active / fallback notice must land on
    // the report channel at assembly time, not on first tool use.
    const sandbox = stubSandbox({ initial: ['grants active on 3 roots'] });
    const reported: string[] = [];
    createShellLauncher({ sandbox, onNotice: (n) => reported.push(n) });
    expect(reported).toEqual(['grants active on 3 roots']);
  });

  it('notices produced by a wrap are drained and reported right after that wrap', async () => {
    const sandbox = stubSandbox({ rounds: [[], ['tier-2 not wrapping bash.exe (label)']] });
    const reported: string[] = [];
    const launcher = createShellLauncher({ sandbox, onNotice: (n) => reported.push(n) });
    await launcher.run(nodeInv('console.log("x")'), { cwd, signal: new AbortController().signal, timeoutMs: 5_000 });
    expect(reported).toEqual([]); // first wrap accumulated nothing
    const handle = launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd });
    expect(reported).toEqual(['tier-2 not wrapping bash.exe (label)']);
    handle.kill('SIGKILL');
  });

  it('a notice is reported exactly once (drain empties; later wraps re-drain nothing)', () => {
    const sandbox = stubSandbox({ rounds: [['notice A'], []] });
    const spy = vi.fn();
    const launcher = createShellLauncher({ sandbox, onNotice: spy });
    launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd }).kill('SIGKILL');
    launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd }).kill('SIGKILL');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('notice A');
  });

  it('default report channel writes "[sandbox] <notice>" to stderr', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sandbox = stubSandbox({ initial: ['degraded'] });
      createShellLauncher({ sandbox });
      expect(errSpy).toHaveBeenCalledWith('[sandbox] degraded');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('unsandboxed adapter', () => {
  it('returns the invocation unchanged and never reports notices', () => {
    const inv = nodeInv('0');
    expect(unsandboxed.wrapSpawn(inv, 'C:/anything')).toBe(inv);
    expect(unsandboxed.drainNotices()).toEqual([]);
    const spy = vi.fn();
    const launcher = createShellLauncher({ sandbox: unsandboxed, onNotice: spy });
    const handle = launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd });
    handle.kill('SIGKILL');
    expect(spy).not.toHaveBeenCalled();
  });
});
