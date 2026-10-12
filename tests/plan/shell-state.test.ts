import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitBashPathToWindowsPath, windowsPathToGitBashPath } from '../../src/shared/paths.js';
import { buildSnapshotReplay, createPlainShellState } from '../../src/tools/shell-state.js';
import type { ShellInitSnapshot } from '../../src/tools/shell-init-snapshot.js';
import type { ShellPlan, SpawnInvocation } from '../../src/tools/shell-routing.js';
import { createBashTool } from '../../src/tools/bash.js';
import type { ShellLauncher, LauncherRunOptions } from '../../src/tools/shell-launcher.js';
import type { RunResult } from '../../src/tools/spawn-runner.js';

/**
 * shell-snapshot ticket 02: the bash DEFAULT path gets snapshot replay +
 * cwd carry-over through ONE small state façade; the session and powershell
 * paths must not change, and everything degrades to today's plain command.
 */

const bashPlan: ShellPlan = { kind: 'bash', path: '/bin/bash', transport: 'argv', label: 'bash' };
const cmdPlan: ShellPlan = { kind: 'cmd', label: 'cmd.exe' };

const snapshot: ShellInitSnapshot = {
  path: 'C:/snap/current.sh',
  shellPath: '/c/snap/current.sh',
};

describe('buildSnapshotReplay (pure command wrapper)', () => {
  it('foreground: prelude source, user command, pwd -P tail, exit code carried', () => {
    const out = buildSnapshotReplay({
      command: 'echo hello',
      snapshotShellPath: '/c/snap/current.sh',
      cwdFileShellPath: '/c/temp/nova-cwd-1',
    });
    expect(out).toContain("source '/c/snap/current.sh' 2>/dev/null || true");
    expect(out).toContain('echo hello');
    expect(out).toMatch(/__nova_st=\$\?/);
    expect(out).toMatch(/if \[ "\$__nova_st" -eq 0 \]; then pwd -P > '\/c\/temp\/nova-cwd-1'; fi/);
    expect(out).toMatch(/exit "\$__nova_st"/);
    // user command must run BEFORE the tail can rewrite state
    expect(out.indexOf('echo hello')).toBeLessThan(out.indexOf('pwd -P'));
  });

  it('background: prelude only (nobody reads the cwd file before the job ends)', () => {
    const out = buildSnapshotReplay({
      command: 'sleep 5',
      snapshotShellPath: '/c/snap/current.sh',
    });
    expect(out).toContain("source '/c/snap/current.sh'");
    expect(out).not.toContain('pwd -P');
  });

  it("paths containing apostrophes are shell-escaped, not quote-broken", () => {
    const hostile = "/c/Users/O'Brien/snap 'quoted'.sh";
    const out = buildSnapshotReplay({
      command: 'echo hi',
      snapshotShellPath: hostile,
      cwdFileShellPath: hostile + '.cwd',
    });
    // '\'' escaping, never a raw embedded apostrophe inside single quotes.
    expect(out).toContain("O'\\''Brien");
    // and the whole wrapped script still parses under real bash WITH those paths
    const file = path.join(os.tmpdir(), 'nova-replay-apostrophe.sh');
    fs.writeFileSync(file, out, 'utf-8');
    try {
      execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return;
      throw err;
    }
  });

  it('the wrapped script parses under real bash', () => {
    const file = path.join(os.tmpdir(), 'nova-replay-parse.sh');
    fs.writeFileSync(
      file,
      buildSnapshotReplay({
        command: 'echo a && echo b',
        snapshotShellPath: '/tmp/none.sh',
        cwdFileShellPath: '/tmp/cwdf',
      }),
      'utf-8',
    );
    try {
      execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return; // dev box w/o bash
      throw err;
    }
  });
});

describe('windowsPathToGitBashPath', () => {
  it('renders windows dirs for shell text', () => {
    expect(windowsPathToGitBashPath('C:\\Users\\me\\proj')).toBe('/c/Users/me/proj');
    expect(windowsPathToGitBashPath('/Users/me/proj')).toBe('/Users/me/proj');
  });
});

describe('plain shell state facade', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-shell-state-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const makeState = (
    snap: ShellInitSnapshot | undefined,
    overrides: { cwdFileDir?: string } = {},
  ) => {
    let created = 0;
    const state = createPlainShellState({
      snapshotManagerFactory: () => {
        created += 1;
        return { getOrCreate: async () => snap };
      },
      cwdFileDir: () => overrides.cwdFileDir ?? tmp,
    });
    return { state, createdCount: () => created };
  };

  it('non-bash plans are never wrapped', async () => {
    const { state } = makeState(snapshot);
    const w = await state.wrap(cmdPlan, 'echo hi', { captureCwd: true });
    expect(w.command).toBe('echo hi');
    expect(w.cwdFile).toBeUndefined();
  });

  it('no snapshot (creation failed) = today behavior, one creation attempt total', async () => {
    const { state, createdCount } = makeState(undefined);
    const w1 = await state.wrap(bashPlan, 'echo hi', { captureCwd: true });
    const w2 = await state.wrap(bashPlan, 'echo ho', { captureCwd: true });
    expect(w1.command).toBe('echo hi');
    expect(w2.command).toBe('echo ho');
    expect(createdCount()).toBe(1);
  });

  it('cwd starts at the injected default and carries across successful settles', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cwd-target-'));
    const { state } = makeState(snapshot);
    expect(state.cwd(target)).toBe(target);
    const w = await state.wrap(bashPlan, 'cd x', { captureCwd: true });
    expect(w.cwdFile).toBeDefined();
    // Simulate the shell tail writing the new pwd.
    fs.writeFileSync(w.cwdFile!, windowsPathToGitBashPath(target).replace(/^\/([A-Za-z])/, (_m, c: string) => `/${c.toLowerCase()}`), 'utf-8');
    state.settle(w.cwdFile);
    expect(state.cwd('/other')).not.toBe('/other');
    expect(path.resolve(state.cwd(target)!)).toBe(path.resolve(target));
    expect(fs.existsSync(w.cwdFile!)).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('a captured path that is not a directory (deleted, stale) never poisons cwd', async () => {
    const { state } = makeState(snapshot);
    const w = await state.wrap(bashPlan, 'rm -rf /tmp/x', { captureCwd: true });
    fs.writeFileSync(w.cwdFile!, windowsPathToGitBashPath(path.join(tmp, 'ghost')) , 'utf-8');
    state.settle(w.cwdFile);
    expect(state.cwd(undefined)).toBeUndefined();
    expect(fs.existsSync(w.cwdFile!)).toBe(false);
  });

  it('a failed command leaves no file and does not move the cwd', async () => {
    const initial = path.join(tmp, 'start');
    fs.mkdirSync(initial);
    const { state } = makeState(snapshot);
    state.settle(undefined); // no file at all (non-zero exit)
    expect(state.cwd(initial)).toBe(initial);
  });
});

describe('bash tool wiring (default path only)', () => {
  let tmp: string;
  let snap: ShellInitSnapshot;
  let wiredState: () => ReturnType<typeof createPlainShellState>;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-bash-wire-'));
    const snapFile = path.join(tmp, 'current.sh');
    fs.writeFileSync(snapFile, '# snap\n', 'utf-8');
    snap = { path: snapFile, shellPath: windowsPathToGitBashPath(snapFile) };
    wiredState = () =>
      createPlainShellState({
        snapshotManagerFactory: () => ({ getOrCreate: async () => snap }),
        cwdFileDir: () => tmp,
      });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  interface Captured {
    invocation: SpawnInvocation;
    cwd: string;
  }

  function fakeLauncher(capture: (c: Captured) => void, exitCode = 0): ShellLauncher {
    return {
      run: async (invocation: SpawnInvocation, options: LauncherRunOptions): Promise<RunResult> => {
        capture({ invocation, cwd: options.cwd });
        return exitCode === 0
          ? { content: 'ok', exitCode }
          : { content: 'ok', exitCode, isError: true };
      },
      start: async () => ({ pid: 1, stdin: { write() {}, end() {}, on() {} }, kill: () => true }),
    } as unknown as ShellLauncher;
  }

  it('foreground plain call: spawn uses state cwd, command is wrapped, settle runs with the cwd file', async () => {
    const captured: Captured[] = [];
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-carry-target-'));
    const state = wiredState();
    // The fake shell plays along: a wrapped command's pwd tail file receives
    // the target dir, like the real tail would on exit 0.
    const launcher: ShellLauncher = {
      run: async (invocation: SpawnInvocation, options: LauncherRunOptions): Promise<RunResult> => {
        captured.push({ invocation, cwd: options.cwd });
        const cmd = invocation.args[invocation.args.length - 1] ?? '';
        const m = /pwd -P > '([^']+)'; fi/.exec(cmd);
        if (m) fs.writeFileSync(gitBashPathToWindowsPath(m[1]!), windowsPathToGitBashPath(target), 'utf-8');
        return { content: 'ok', exitCode: 0 };
      },
      start: async () => ({}) as never,
    } as unknown as ShellLauncher;
    const tool = createBashTool({ resolvePlan: () => bashPlan, launcher, state });
    const r = await tool.execute({ command: 'echo hi' }, { workingDirectory: tmp, abortSignal: new AbortController().signal });
    expect(r.isError).toBeUndefined();
    expect(captured).toHaveLength(1);
    const cmd = captured[0].invocation.args[1] ?? '';
    expect(cmd).toContain(`source '${windowsPathToGitBashPath(snap.path)}'`);
    expect(cmd).toContain('echo hi');
    expect(cmd).toContain('pwd -P');
    expect(captured[0].cwd).toBe(tmp); // first call: fallback
    // settle carried the cwd and cleaned the capture file: next call spawns there.
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('nova-cwd-'))).toEqual([]);
    await tool.execute({ command: 'echo again' }, { workingDirectory: tmp, abortSignal: new AbortController().signal });
    expect(captured[1].cwd).toBe(fs.realpathSync(target));
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('no state facade => byte-identical plain behavior (session tests unaffected)', async () => {
    const captured: Captured[] = [];
    const tool = createBashTool({ resolvePlan: () => bashPlan, launcher: fakeLauncher((c) => captured.push(c)) });
    await tool.execute({ command: 'echo hi' }, { workingDirectory: tmp, abortSignal: new AbortController().signal });
    expect(captured[0].invocation.args[1]).toBe('echo hi');
    expect(captured[0].cwd).toBe(tmp);
  });

  it('cmd plan through state: still plain, still launcher-default cwd', async () => {
    const captured: Captured[] = [];
    const tool = createBashTool({ resolvePlan: () => cmdPlan, launcher: fakeLauncher((c) => captured.push(c)), state: wiredState() });
    await tool.execute({ command: 'dir' }, { workingDirectory: tmp, abortSignal: new AbortController().signal });
    expect(captured[0].invocation.args.join(' ')).toContain('dir');
    expect(captured[0].invocation.args[3]).toBe('dir');
  });

  it('background jobs replay the snapshot but never claim a cwd', async () => {
    const started: Captured[] = [];
    const launcher = fakeLauncher((c) => started.push(c));
    const tool = createBashTool({
      resolvePlan: () => bashPlan,
      launcher,
      state: wiredState(),
      jobs: {
        startFrom: (command: string, invocation: SpawnInvocation, opts: { cwd: string }) => {
          started.push({ invocation, cwd: opts.cwd });
          return { started: true as const, jobId: 'j1', pid: 42 };
        },
      } as never,
    });
    const r = await tool.execute({ command: 'sleep 1', background: true }, { workingDirectory: tmp, abortSignal: new AbortController().signal });
    expect(r.isError).toBeUndefined();
    const cmd = started[0].invocation.args[1] ?? '';
    expect(cmd).toContain('source');
    expect(cmd).not.toContain('pwd -P');
  });

  it('description teaches the contract when a state facade is wired', () => {
    const withState = createBashTool({ state: wiredState() });
    expect(withState.description).toContain('cwd carries over');
    expect(withState.description).toContain('env changes do NOT persist');
    const plain = createBashTool();
    expect(plain.description).not.toContain('carry');
  });
});
