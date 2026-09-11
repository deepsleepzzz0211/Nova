import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readGitBranch, startBranchRefresh } from '../../src/tui/git-branch.js';

describe('readGitBranch (tui-refactor 09)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature-x\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the branch from .git/HEAD', () => {
    expect(readGitBranch(dir)).toBe('feature-x');
  });

  it('finds the repository from a subdirectory', () => {
    const sub = path.join(dir, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    expect(readGitBranch(sub)).toBe('feature-x');
    fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
  });

  it('supports worktrees where .git is a gitdir pointer file', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-wt-'));
    const real = path.join(wt, 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'HEAD'), 'ref: refs/heads/worktree-branch\n');
    const worktree = path.join(wt, 'checkout');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${real}\n`);
    expect(readGitBranch(worktree)).toBe('worktree-branch');
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it('returns a short sha for a detached HEAD', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git2-'));
    fs.mkdirSync(path.join(d2, '.git'));
    fs.writeFileSync(path.join(d2, '.git', 'HEAD'), 'a'.repeat(40) + '\n');
    expect(readGitBranch(d2)).toBe('aaaaaaaa');
    fs.rmSync(d2, { recursive: true, force: true });
  });

  it('returns null outside a repository', () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-git3-'));
    expect(readGitBranch(d3)).toBeNull();
    fs.rmSync(d3, { recursive: true, force: true });
  });
});

describe('startBranchRefresh (ticket 23)', () => {
  it('reports the branch on each tick and stops cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-refresh-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/first\n');

    const seen: Array<string | null> = [];
    const stop = startBranchRefresh((branch) => seen.push(branch), 5, dir);
    await new Promise((r) => setTimeout(r, 30));
    // A checkout in another terminal is picked up on the next tick.
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/second\n');
    await new Promise((r) => setTimeout(r, 30));
    stop();
    const countAtStop = seen.length;
    await new Promise((r) => setTimeout(r, 30));

    expect(seen[0]).toBe('first');
    expect(seen).toContain('second');
    expect(seen.length).toBe(countAtStop); // no ticks after stop
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
