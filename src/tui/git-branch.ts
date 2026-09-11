import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Git branch detection for the status footer (tui-refactor ticket 09).
 * Filesystem I/O lives here; `status-format.ts` stays pure.
 */

/** Resolve the .git directory for a working directory (walking upward;
 * supports worktrees, where .git is a file pointing at the real gitdir). */
function resolveGitDir(dir: string): string | null {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 40; depth++) {
    const candidate = path.join(current, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        // Worktree / submodule: ".git" contains "gitdir: <path>"
        const pointer = fs.readFileSync(candidate, 'utf-8').trim();
        const match = /^gitdir:\s*(.+)$/.exec(pointer);
        if (match) {
          return path.isAbsolute(match[1]) ? match[1] : path.resolve(current, match[1]);
        }
        return null;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Current git branch for `dir` (or the nearest ancestor repository), a
 * short sha for a detached HEAD, or null when not inside a repository.
 * Supports worktrees; reads .git/HEAD only (no subprocess).
 */
export function readGitBranch(dir: string): string | null {
  const gitDir = resolveGitDir(dir);
  if (gitDir === null) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (match) return match[1];
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 8);
    return null;
  } catch {
    return null;
  }
}
