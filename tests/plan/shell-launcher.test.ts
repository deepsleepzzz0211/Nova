import { describe, it, expect } from 'vitest';
import { createShellLauncher, identityWrap, type WrapSpawn } from '../../src/tools/shell-launcher.js';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

// Arch ticket 02: ONE launcher seam spawns every shell child (foreground
// run, background start, hook capture, interactive session). The OS wrap is
// applied inside — a caller CANNOT spawn without passing through it; an
// unwrapped path is an explicit identityWrap choice, never a forgotten
// optional. Tests cross the interface with real tiny node processes.

const cwd = os.tmpdir();
const nodeInv = (js: string, ...args: string[]): import('../../src/tools/shell-routing.js').SpawnInvocation => ({
  file: process.execPath,
  args: ['-e', js, ...args],
  stdinText: undefined,
});

describe('ShellLauncher.run', () => {
  it('collects merged output and exit code through the wrap point', async () => {
    const seen: string[] = [];
    const wrap: WrapSpawn = (inv) => {
      seen.push(inv.file);
      return inv;
    };
    const launcher = createShellLauncher({ wrap });
    const r = await launcher.run(nodeInv('console.log("hi"); console.error("oops")'), {
      cwd,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
    });
    expect(r.content).toContain('hi');
    expect(r.content).toContain('oops');
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([process.execPath]); // wrapped exactly once
  });

  it('timeout ladder: SIGTERM then the run resolves non-zero (sleep cannot outlive it)', async () => {
    const launcher = createShellLauncher({ wrap: identityWrap });
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
    const launcher = createShellLauncher({ wrap: identityWrap });
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

  it('the wrap is applied here too — no un-wrapped side door', async () => {
    let calls = 0;
    const launcher = createShellLauncher({
      wrap: (inv) => {
        calls++;
        return inv;
      },
    });
    await launcher.capture(nodeInv('console.log(1)'), { cwd, timeoutMs: 5_000 });
    expect(calls).toBe(1);
  });
});

describe('ShellLauncher.start (background jobs)', () => {
  it('returns a JobHandle with pid and streaming stdout', async () => {
    const launcher = createShellLauncher({ wrap: identityWrap });
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

  it('start goes through the wrap (sandboxed children cannot escape via background)', () => {
    let wrapped = 0;
    const launcher = createShellLauncher({
      wrap: (inv) => {
        wrapped++;
        return inv;
      },
    });
    const handle = launcher.start(nodeInv('setTimeout(()=>{},50)'), { cwd });
    expect(wrapped).toBe(1);
    handle.kill('SIGKILL');
  });
});

describe('ShellLauncher.interactive (session shells)', () => {
  it('pipes stdin->stdout through the wrapped child', async () => {
    const echoes: string[] = [];
    const launcher = createShellLauncher({
      wrap: (inv) => {
        echoes.push(inv.file);
        return inv;
      },
    });
    const proc = launcher.interactive(nodeInv('process.stdin.pipe(process.stdout)'), { cwd });
    const out: string[] = [];
    proc.stdout!.on('data', (d: Buffer) => out.push(d.toString()));
    proc.stdin!.end('through-me\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(out.join('')).toContain('through-me');
    expect(echoes).toEqual([process.execPath]);
    proc.kill('SIGKILL');
  });

  it('close/error listeners attachable (EventEmitter contract for ShellProc)', () => {
    const launcher = createShellLauncher({ wrap: identityWrap });
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

describe('identityWrap', () => {
  it('returns the invocation unchanged', () => {
    const inv = nodeInv('0');
    expect(identityWrap(inv, 'C:/anything')).toBe(inv);
  });
});
