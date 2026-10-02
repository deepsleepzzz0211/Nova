import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ShellSessionRegistry,
  type ShellProc,
  type ShellSpawnOptions,
} from '../../src/tools/shell-session.js';
import { createBashTool } from '../../src/tools/bash.js';

// Batch-B ticket 07 (G14b): named persistent bash sessions. Same name reuses
// one long-lived shell (stdin-fed commands, sentinel-framed output); idle
// timeout recycles; a dead shell rebuilds on the next call with a visible
// [session restarted] marker.

class FakeProc extends EventEmitter implements ShellProc {
  pid = 100;
  written: string[] = [];
  killed = false;
  stdin = {
    write: (s: string): boolean => {
      this.written.push(s);
      return true;
    },
    end: (): void => {},
    on: (): void => {},
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
  /** Answer the last-written sentinel the way the spike protocol does. */
  answer(output: string, rc: number): void {
    const wire = this.written[this.written.length - 1] ?? '';
    const m = wire.match(/"(__NOVA_[^"]+\$\?)"/);
    if (m === null) throw new Error('no sentinel in last write');
    this.stdout.emit('data', Buffer.from(`\n${output}\n${m[1].replace('$?', String(rc))}\n`));
  }
}

function makeFactory(): {
  spawns: ShellSpawnOptions[];
  procs: FakeProc[];
  spawn: (opts: ShellSpawnOptions) => ShellProc;
} {
  const spawns: ShellSpawnOptions[] = [];
  const procs: FakeProc[] = [];
  return {
    spawns,
    procs,
    spawn: (opts) => {
      spawns.push(opts);
      const p = new FakeProc();
      p.pid = 100 + spawns.length;
      procs.push(p);
      return p;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bash tool session integration', () => {
  it('routes session calls through the registry and prefixes restart markers', async () => {
    const f = makeFactory();
    vi.useRealTimers();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const bash = createBashToolForTest(reg);
    const ctx = { workingDirectory: '/w', abortSignal: new AbortController().signal };
    const p = bash.execute({ command: 'pwd', session: 'dev' }, ctx);
    await vi.waitFor(() => expect(f.procs.length).toBe(1));
    f.procs[0].answer('/w/sub', 0);
    const r = await p;
    expect(r.content).toContain('/w/sub');
    expect(r.isError).toBeUndefined();

    // Simulate a crash between calls: next result carries the marker.
    f.procs[0].emit('close', null);
    const p2 = bash.execute({ command: 'ls', session: 'dev' }, ctx);
    await vi.waitFor(() => expect(f.procs.length).toBe(2));
    f.procs[1].answer('files', 0);
    const r2 = await p2;
    expect(r2.content).toContain('[session restarted]');
    expect(r2.content).toContain('files');
  });

  it('session_reset drops the shell without a restart marker', async () => {
    const f = makeFactory();
    vi.useRealTimers();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const bash = createBashToolForTest(reg);
    const ctx = { workingDirectory: '/w', abortSignal: new AbortController().signal };
    const p = bash.execute({ command: 'true', session: 's' }, ctx);
    await vi.waitFor(() => expect(f.procs.length).toBe(1));
    f.procs[0].answer('x', 0);
    await p;
    const p2 = bash.execute({ command: 'true', session: 's', session_reset: true }, ctx);
    await vi.waitFor(() => expect(f.procs.length).toBe(2));
    f.procs[1].answer('y', 0);
    const r2 = await p2;
    expect(f.procs[0].killed).toBe(true);
    expect(r2.content).not.toContain('[session restarted]');
    expect(r2.content).toContain('y');
  });

  it('reports transport failure (exit -1) as a tool error', async () => {
    const f = makeFactory();
    vi.useRealTimers();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const bash = createBashToolForTest(reg);
    const ctx = { workingDirectory: '/w', abortSignal: new AbortController().signal };
    const p = bash.execute({ command: 'boom', session: 's' }, ctx);
    await vi.waitFor(() => expect(f.procs.length).toBe(1));
    f.procs[0].emit('close', null);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/session died/i);
  });
});

function createBashToolForTest(reg: ShellSessionRegistry) {
  return createBashTool({
    resolvePlan: () => ({ kind: 'bash', path: 'bash', transport: 'argv', label: 'bash' }),
    sessions: reg,
  });
}

describe('ShellSessionRegistry lifecycle', () => {
  it('builds the shell on first use and reuses it for later calls', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const p1 = reg.run('dev', 'make', '/w');
    f.procs[0].answer('built', 0);
    expect((await p1).out).toContain('built');

    const p2 = reg.run('dev', './app --check', '/w');
    expect(f.spawns.length).toBe(1); // reused
    f.procs[0].answer('ok', 0);
    const r2 = await p2;
    expect(r2.out).toContain('ok');
    expect(r2.restarted).toBe(false);
  });

  it('different names get different shells', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const a = reg.run('one', 'true', '/w');
    f.procs[0].answer('A', 0);
    await a;
    const b = reg.run('two', 'true', '/w');
    expect(f.spawns.length).toBe(2);
    f.procs[1].answer('B', 0);
    expect((await b).out).toContain('B');
  });

  it('serializes concurrent commands on one session in call order', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const first = reg.run('s', 'cmd1', '/w');
    const second = reg.run('s', 'cmd2', '/w');
    expect(f.spawns.length).toBe(1);
    // Only cmd1 is on the wire until its sentinel returns
    expect(f.procs[0].written.filter((w) => w.includes('cmd1')).length).toBe(1);
    expect(f.procs[0].written.some((w) => w.includes('cmd2'))).toBe(false);
    f.procs[0].answer('one', 0);
    expect((await first).out).toContain('one');
    expect(f.procs[0].written.some((w) => w.includes('cmd2'))).toBe(true);
    f.procs[0].answer('two', 0);
    expect((await second).out).toContain('two');
  });

  it('reports exit codes from the sentinel tail', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const r = reg.run('s', 'false', '/w');
    f.procs[0].answer('', 1);
    expect((await r).exitCode).toBe(1);
  });

  it('recycles an idle shell and rebuilds silently afterwards', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn, idleMs: 1000 });
    const first = reg.run('s', 'true', '/w');
    f.procs[0].answer('x', 0);
    await first;
    expect(f.procs[0].killed).toBe(false);
    vi.advanceTimersByTime(1200);
    expect(f.procs[0].killed).toBe(true);

    const next = reg.run('s', 'true', '/w');
    expect(f.spawns.length).toBe(2);
    f.procs[1].answer('fresh', 0);
    const r = await next;
    expect(r.restarted).toBe(false); // idle recycle is not a crash
  });

  it('rebuilds after an unexpected exit and marks the result', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const first = reg.run('s', 'exit', '/w');
    f.procs[0].answer('bye', 0);
    await first;
    f.procs[0].emit('close', null); // shell died (e.g. `exit`)

    const next = reg.run('s', 'pwd', '/w');
    expect(f.spawns.length).toBe(2);
    f.procs[1].answer('/w', 0);
    const r = await next;
    expect(r.restarted).toBe(true);
  });

  it('a mid-command death rejects that command and rebuilds for the next', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const cmd = reg.run('s', 'hang', '/w');
    f.procs[0].emit('close', null);
    const r = await cmd;
    expect(r.exitCode).toBe(-1);
    expect(r.out).toMatch(/session died/i);
    const next = reg.run('s', 'pwd', '/w');
    expect(f.spawns.length).toBe(2);
    f.procs[1].answer('/w', 0);
    expect((await next).restarted).toBe(true);
  });

  it('reset drops the shell; the next call starts clean without a marker', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const first = reg.run('s', 'true', '/w');
    f.procs[0].answer('x', 0);
    await first;
    reg.reset('s');
    expect(f.procs[0].killed).toBe(true);
    const next = reg.run('s', 'true', '/w');
    f.procs[1].answer('y', 0);
    expect((await next).restarted).toBe(false);
  });

  it('disposeAll kills every session (shutdown path)', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const a = reg.run('one', 'true', '/w');
    const b = reg.run('two', 'true', '/w');
    f.procs[0].answer('1', 0);
    f.procs[1].answer('2', 0);
    await Promise.all([a, b]);
    reg.disposeAll();
    expect(f.procs.every((p) => p.killed)).toBe(true);
  });

  it('run timeout kills the shell and errors the command', async () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    const cmd = reg.run('s', 'sleep 999', '/w', 5000);
    vi.advanceTimersByTime(5100);
    const r = await cmd;
    expect(f.procs[0].killed).toBe(true);
    expect(r.out).toMatch(/timed out/i);
    expect(r.exitCode).toBe(-1);
  });

  it('unknown reset names are no-ops', () => {
    const f = makeFactory();
    const reg = new ShellSessionRegistry({ spawn: f.spawn });
    expect(() => reg.reset('ghost')).not.toThrow();
    expect(() => reg.disposeAll()).not.toThrow();
  });
});
