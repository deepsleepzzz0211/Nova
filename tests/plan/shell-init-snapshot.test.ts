import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { windowsPathToGitBashPath, gitBashPathToWindowsPath } from '../../src/shared/paths.js';
import {
  supportsShellInitSnapshot,
  buildShellInitSnapshotCreationScript,
  createShellInitSnapshotManager,
  cleanupStaleShellInitSnapshots,
} from '../../src/tools/shell-init-snapshot.js';
import type { ShellPlan } from '../../src/tools/shell-routing.js';

/**
 * shell-snapshot ticket 01: the snapshot MANAGER only (ZCode-proven shape).
 * Creation is lazy + cached + failure-degrading, supports just the bash
 * family (posix + git-bash; cmd never gets here), captures user state
 * WITHOUT environment values (no secrets on disk), and sweeps its own dir.
 */

describe('git-bash <-> windows path conversion', () => {
  it('windows to git-bash: drive letter, separators, spaces kept', () => {
    expect(windowsPathToGitBashPath('C:\\temp\\snap.a b.sh')).toBe('/c/temp/snap.a b.sh');
    expect(windowsPathToGitBashPath('D:/project/codeagent/x')).toBe('/d/project/codeagent/x');
  });

  it('git-bash to windows round-trips', () => {
    expect(gitBashPathToWindowsPath('/c/temp/snap.sh')).toBe('C:\\temp\\snap.sh');
    expect(gitBashPathToWindowsPath('/d/project/x/y')).toBe('D:\\project\\x\\y');
  });

  it('non-drive paths pass through untouched', () => {
    expect(gitBashPathToWindowsPath('/usr/bin/sh')).toBe('/usr/bin/sh');
    expect(windowsPathToGitBashPath('/usr/bin/sh')).toBe('/usr/bin/sh');
  });
});

const bashPlan: ShellPlan = { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', transport: 'argv', label: 'Git Bash' };

describe('snapshot dialect gate', () => {
  it('bash-family plans snapshot; cmd does not', () => {
    expect(supportsShellInitSnapshot(bashPlan)).toBe(true);
    expect(supportsShellInitSnapshot({ kind: 'cmd', label: 'cmd.exe' })).toBe(false);
  });
});

describe('creation script (ZCode-proven capture, no env dump)', () => {
  const base = {
    shellKind: 'bash' as const,
    snapshotPath: '/c/temp/snap.sh',
    configPath: '/c/Users/me/.bashrc',
  };

  it('sources the rc, exports functions/options/PATH, never raw env', () => {
    const script = buildShellInitSnapshotCreationScript({ ...base, configExists: true, pathValue: '/c/bin:/x' });
    expect(script).toContain('.bashrc');
    expect(script).toContain('unalias -a');
    expect(script).toMatch(/declare -F|declare -f/);
    expect(script).toContain('shopt -s expand_aliases');
    expect(script).toContain('export PATH=');
    expect(script).toContain('/c/bin:/x');
    // The absolute rule: no environment-value capture — nothing can leak secrets.
    expect(script).not.toMatch(/\benv -0\b/);
    expect(script).not.toContain('export -p');
  });

  it('the generated bash script passes `bash -n` (escape regressions die here)', (ctx) => {
    // Spawn real bash to PARSE the script — catches quoting bugs the string
    // assertions cannot. bash is present on every supported platform
    // (Git Bash on win32, default shell on CI ubuntu/macos legs).
    let script: string;
    for (const kind of ['bash', 'zsh'] as const) {
      script = buildShellInitSnapshotCreationScript({
        shellKind: kind,
        snapshotPath: '/tmp/nova-snap-parse.sh',
        configPath: '/tmp/.nova-missing-rc',
        configExists: kind === 'bash',
        pathValue: '/x bin:"weird"',
      });
      const file = path.join(os.tmpdir(), `nova-snap-parse-${kind}.sh`);
      fs.writeFileSync(file, script, 'utf-8');
      try {
        execFileSync('bash', ['-n', file], { stdio: 'pipe' });
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          ctx.skip('bash not on PATH on this dev box; live ticket covers it');
          return;
        }
        throw new Error(`bash -n failed for ${kind} script: ${(err as { stderr?: Buffer }).stderr?.toString() ?? String(err)}`);
      }
    }
  });

  it('strips winpty aliases on msys/cygwin so headless spawns do not die', () => {
    const script = buildShellInitSnapshotCreationScript({ ...base, configExists: true, pathValue: '' });
    expect(script).toMatch(/msys\)|cygwin/);
    expect(script).toContain('winpty');
  });

  it('zsh variant uses typeset/alias -L/setopt', () => {
    const script = buildShellInitSnapshotCreationScript({
      ...base,
      shellKind: 'zsh',
      snapshotPath: '/tmp/snap.sh',
      configPath: '/root/.zshrc',
      configExists: true,
      pathValue: '',
    });
    expect(script).toContain('typeset');
    expect(script).toContain('setopt');
    expect(script).toContain('alias');
  });
});

describe('snapshot manager', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-snap-mgr-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs the creation exactly once per manager (cached promise)', async () => {
    let execs = 0;
    const mgr = createShellInitSnapshotManager({
      rootDir: root,
      shellPath: path.join(root, 'bash.exe'),
      home: root,
      execFile: async () => {
        execs += 1;
        return { stdout: '/p\n', stderr: '' };
      },
    });
    expect(await mgr.getOrCreate()).toBeUndefined(); // script never produced the file
    expect(await mgr.getOrCreate()).toBeUndefined();
    expect(execs).toBe(1);
  });

  it('returns {path, shellPath} when the script produced the snapshot file', async () => {
    const mgr = createShellInitSnapshotManager({
      rootDir: root,
      shellPath: path.join(root, 'bin', 'bash.exe'),
      home: root,
      execFile: async (_file, args) => {
        // Act like the real -c -l invocation: parse our own SNAPSHOT_FILE line
        // and write the file (git-bash path back into this OS's form).
        const script = args[args.length - 1] ?? '';
        const m = /SNAPSHOT_FILE='([^']+)'/.exec(script);
        expect(m).not.toBeNull();
        const win = gitBashPathToWindowsPath(m ? m[1] : '');
        fs.mkdirSync(path.dirname(win), { recursive: true });
        fs.writeFileSync(win, '# snap\n', 'utf-8');
        return { stdout: '/git/bin\n', stderr: '' };
      },
    });
    const snap = await mgr.getOrCreate();
    expect(snap).toBeDefined();
    expect(snap!.path.endsWith('.sh')).toBe(true);
    expect(fs.existsSync(snap!.path)).toBe(true);
    // shellPath is the git-bash rendering for embedding into -c commands.
    expect(snap!.shellPath.startsWith('/')).toBe(true);
  });

  it('a hung exec is abandoned at the bound and degrades to undefined', async () => {
    const mgr = createShellInitSnapshotManager({
      rootDir: root,
      shellPath: 'x',
      home: root,
      execTimeoutMs: 10,
      execFile: () => new Promise(() => undefined),
    });
    expect(await mgr.getOrCreate()).toBeUndefined();
  });

  it('a throwing exec degrades to undefined and is remembered (no retry storm)', async () => {
    let calls = 0;
    const mgr = createShellInitSnapshotManager({
      rootDir: root,
      shellPath: 'x',
      home: root,
      execFile: async () => {
        calls += 1;
        throw new Error('spawn failed');
      },
    });
    expect(await mgr.getOrCreate()).toBeUndefined();
    expect(await mgr.getOrCreate()).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('stale snapshots (> retention days) are swept; fresh ones survive', () => {
    const snapDir = path.join(root, 'shell-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const oldFile = path.join(snapDir, 'snapshot-bash-1.sh');
    const newFile = path.join(snapDir, 'snapshot-bash-2.sh');
    fs.writeFileSync(oldFile, 'x');
    fs.writeFileSync(newFile, 'x');
    const day = 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(Date.now() - 40 * day), new Date(Date.now() - 40 * day));
    expect(cleanupStaleShellInitSnapshots({ rootDir: root, now: new Date(), retentionDays: 30 })).toEqual({ deleted: 1, errors: 0 });
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('a missing snapshot dir sweeps silently', () => {
    expect(cleanupStaleShellInitSnapshots({ rootDir: path.join(root, 'nope'), retentionDays: 30 })).toEqual({ deleted: 0, errors: 0 });
  });
});
