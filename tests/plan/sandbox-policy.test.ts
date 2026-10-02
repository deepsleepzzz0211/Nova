import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractWriteTargets,
  evaluateSandbox,
  normalizeWritePath,
  type SandboxSettings,
} from '../../src/permission/sandbox.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool } from '../../src/shared/tool-contracts.js';

// Batch-B ticket 01 (G2 tier 1): workspace path policy. When
// sandbox.workspaceWrite = false, writes OUTSIDE the workspace (plus the
// NOVA_HOME allow-list) are DENIED by policy — no approval dialog, no
// always-allow escape. Default (true) keeps today's behavior untouched.

function settings(root: string, extra: Partial<SandboxSettings> = {}): SandboxSettings {
  return {
    enabled: true,
    workspaceRoot: root,
    allowRoots: [path.join(root, '.nova')],
    ...extra,
  };
}

describe('extractWriteTargets', () => {
  it('captures shell redirections', () => {
    const r = extractWriteTargets('echo hi > /tmp/out.txt');
    expect(r.paths).toEqual(['/tmp/out.txt']);
    expect(r.unresolvable).toBe(false);
  });

  it('captures appended redirects and multiple targets', () => {
    const r = extractWriteTargets('a >> x.log && b > y.log');
    expect(r.paths.sort()).toEqual(['x.log', 'y.log']);
  });

  it('captures common destructive/creating commands', () => {
    for (const cmd of [
      'rm -rf ../outside',
      'mkdir -p /var/tmp/dir',
      'touch /etc/newfile',
      'cp f.txt /tmp/copy.txt',
      'mv a.txt ../b.txt',
      'tee /tmp/tp < in.txt',
    ]) {
      const r = extractWriteTargets(cmd);
      expect(r.paths.length, cmd).toBeGreaterThan(0);
    }
  });

  it('/dev/null and /dev/stdout style sinks are never write targets', () => {
    const r = extractWriteTargets('cmd 2>/dev/null > /dev/null');
    expect(r.paths).toEqual([]);
    expect(r.unresolvable).toBe(false);
  });

  it('writes through shell variables are unresolvable', () => {
    const r = extractWriteTargets('echo x > $HOME/out.txt');
    expect(r.unresolvable).toBe(true);
  });

  it('a plain read command has no targets and is resolvable', () => {
    expect(extractWriteTargets('cat a.txt && ls -la')).toEqual({ paths: [], unresolvable: false });
  });
});

describe('normalizeWritePath', () => {
  let root: string;
  let real: string;

  const setup = () => {
    // The expectation side must use the SAME normalizer as production
    // (realpathSync.native): on Windows, plain realpathSync does NOT expand
    // 8.3 short ancestors (CI runners: C:\Users\RUNNER~1\...), so
    // string-prefix comparisons against native-resolved paths diverge.
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sbx-'));
    real = path.join(root, 'deep', 'nested');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'f.txt'), 'x');
  };

  it('resolves .. lexically-safe onto the real tree', () => {
    setup();
    try {
      const p = normalizeWritePath(path.join(root, 'deep', 'nested', '..', 'nested', 'f.txt'), root);
      expect(fs.existsSync(p)).toBe(true);
      // Case-insensitive compare: realpathSync.native may return stored
      // segment case (Temp vs temp) on Windows — same tree either way.
      const fold = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
      expect(fold(p).startsWith(fold(fs.realpathSync.native(real)))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a symlink that escapes the workspace resolves to its target for the check', () => {
    setup();
    const outside = fs.realpathSync.native(path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sbx-out-'))));
    const link = path.join(root, 'link-out');
    try {
      try {
        fs.symlinkSync(outside, link, 'dir');
      } catch {
        return; // platform without symlink privileges (win32 CI) — skip clean
      }
      const resolved = normalizeWritePath(link, root);
      expect(resolved.startsWith(outside)).toBe(true);
      expect(resolved.startsWith(root)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('case-difference on win32 still maps to the same tree (no false escape)', () => {
    setup();
    try {
      const base = fs.realpathSync.native(root);
      const flipped = base.charAt(0).toLowerCase() + base.slice(1);
      const p = normalizeWritePath(path.join(flipped, 'deep', 'f.txt'), base);
      const s = settings(base);
      expect(evaluateSandbox(s, [p]).decision).toBe('allow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('evaluateSandbox', () => {
  let root: string;

  const fresh = () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-eval-')));
    fs.mkdirSync(path.join(root, 'sub'));
  };

  it('denies an outside target with an explanatory reason', () => {
    fresh();
    try {
      const outside = path.join(root, '..', 'definitely-outside.txt');
      const verdict = evaluateSandbox(settings(root), [outside]);
      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'deny') expect(verdict.reason).toMatch(/sandbox/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows inside-workspace and allow-root targets', () => {
    fresh();
    try {
      const s = settings(root);
      expect(evaluateSandbox(s, [path.join(root, 'sub', 'a.ts')]).decision).toBe('allow');
      expect(evaluateSandbox(s, [path.join(root, '.nova', 'state.json')]).decision).toBe('allow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('unresolvable write evidence denies with the conservative reason', () => {
    fresh();
    try {
      const verdict = evaluateSandbox(settings(root), [], { unresolvable: true });
      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'deny') expect(verdict.reason).toMatch(/could not be resolved/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a disabled sandbox allows everything (default = today)', () => {
    fresh();
    try {
      const s = { ...settings(root), enabled: false };
      expect(evaluateSandbox(s, [path.join(root, '..', 'out.txt')], { unresolvable: true }).decision).toBe('allow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const cmdTool: Tool = {
  name: 'bash',
  description: '',
  parameters: { type: 'object', properties: {} },
  display: { kind: 'command' },
  permission: { mode: 'auto' },
  async execute() {
    return { content: '' };
  },
};

const writeTool: Tool = {
  name: 'write_file',
  description: '',
  parameters: { type: 'object', properties: {} },
  fileAccess: 'write',
  permission: { mode: 'ask', message: 'File write requires confirmation' },
  async execute() {
    return { content: '' };
  },
};

describe('PermissionPolicy sandbox layer (tier-1 wiring)', () => {
  let root: string;
  const basePerm = { autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [] as string[] };

  const fresh = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pol-')));

  it('sandbox deny beats the user always-allow list (no escape hatch)', () => {
    root = fresh();
    try {
      const policy = new PermissionPolicy({ ...basePerm, alwaysAllowCommands: ['echo'] }, {
        enabled: true,
        workspaceRoot: root,
        allowRoots: [],
      });
      const d = policy.check('bash', { command: 'echo x > ../../escape.txt' }, cmdTool, root);
      expect(d.decision).toBe('deny');
      expect(d.message).toMatch(/sandbox/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('write_file outside the workspace is denied even though it would only "ask"', () => {
    root = fresh();
    try {
      const policy = new PermissionPolicy(basePerm, { enabled: true, workspaceRoot: root, allowRoots: [] });
      const outside = path.join(root, '..', 'out.ts');
      const d = policy.check('write_file', { path: outside, content: 'x' }, writeTool, root);
      expect(d.decision).toBe('deny');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inside-workspace writes keep the pre-sandbox path (ask, not deny)', () => {
    root = fresh();
    try {
      const policy = new PermissionPolicy(basePerm, { enabled: true, workspaceRoot: root, allowRoots: [] });
      const d = policy.check('write_file', { path: path.join(root, 'in.ts'), content: 'x' }, writeTool, root);
      expect(d.decision).toBe('ask');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('no sandbox settings = today exactly (deny never fires)', () => {
    root = fresh();
    try {
      const policy = new PermissionPolicy(basePerm);
      const d = policy.check('bash', { command: 'echo x > /anywhere/at/all.txt' }, cmdTool, root);
      expect(d.decision).toBe('allow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
