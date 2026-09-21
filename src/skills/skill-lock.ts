/**
 * Skills lock — sha256 integrity pinning for third-party skill repos.
 *
 * An installed skill repo carries a `.skills-lock.json` next to its
 * SKILL.md files listing each skill's content hash. On scan, a skill that
 * lives under such a lock is loaded only when its bytes match; a drifted
 * file or an added file with no lock entry is refused (default-deny within a
 * locked repo). Hand-written skills with no lock are unaffected.
 */

import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Lock file name, written inside a locked skill repo. */
export const SKILL_LOCK_FILENAME = '.skills-lock.json';

/** One pinned skill: path relative to the lock dir (posix separators). */
export interface SkillLockEntry {
  path: string;
  sha256: string;
}

/** The full lock document. */
export interface SkillLock {
  version: 1;
  /** Origin of the pinned skills (git URL, or 'local'). */
  source: string;
  skills: SkillLockEntry[];
}

/** Integrity verdict for a single SKILL.md against its governing lock. */
export type LockVerdict =
  | { status: 'match' }
  | { status: 'drift'; expected: string; actual: string }
  | { status: 'unpinned' };

/** Lowercase hex sha256 of a file's raw bytes. */
export function sha256File(absPath: string): string {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** Relative posix path segments of every SKILL.md under `dir` (recursive). */
function findSkillRelPaths(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(toPosixRel(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

/** posix-style path of `abs` relative to `base`. */
function toPosixRel(base: string, abs: string): string {
  return path.relative(base, abs).split(path.sep).join('/');
}

/** Build a lock pinning every SKILL.md under `dir` to its current bytes. */
export function buildSkillLock(dir: string, source: string): SkillLock {
  return {
    version: 1,
    source,
    skills: findSkillRelPaths(dir).map((rel) => ({
      path: rel,
      sha256: sha256File(path.join(dir, rel)),
    })),
  };
}

/** Build and persist `<dir>/.skills-lock.json` (install / explicit re-pin). */
export function writeSkillLock(dir: string, source: string): SkillLock {
  const lock = buildSkillLock(dir, source);
  fs.writeFileSync(
    path.join(dir, SKILL_LOCK_FILENAME),
    JSON.stringify(lock, null, 2) + '\n',
    'utf-8',
  );
  return lock;
}

/** Read a lock file; null when missing or malformed (fail-open to caller). */
export function readSkillLock(lockFilePath: string): SkillLock | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFilePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SkillLock>;
    if (parsed && Array.isArray(parsed.skills)) {
      return { version: 1, source: typeof parsed.source === 'string' ? parsed.source : '', skills: parsed.skills };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Nearest directory at-or-above the skill file (bounded by `scanRoot`) that
 * holds a lock file, or null when the skill is not under any lock.
 */
export function lockDirFor(skillFileAbs: string, scanRoot: string): string | null {
  const root = path.resolve(scanRoot);
  let dir = path.dirname(path.resolve(skillFileAbs));
  for (;;) {
    if (fs.existsSync(path.join(dir, SKILL_LOCK_FILENAME))) return dir;
    // Stop once we climb to or past the scan root (no enclosing lock found).
    const rel = path.relative(root, dir);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return null;
    }
    dir = path.dirname(dir);
  }
}

/** Verify one SKILL.md against the lock rooted at `lockDir`. */
export function verifySkillFile(lockDir: string, skillFileAbs: string, lock: SkillLock): LockVerdict {
  const rel = toPosixRel(lockDir, skillFileAbs);
  const entry = lock.skills.find((s) => s.path === rel);
  if (!entry) return { status: 'unpinned' };
  const actual = sha256File(skillFileAbs);
  if (actual !== entry.sha256) return { status: 'drift', expected: entry.sha256, actual };
  return { status: 'match' };
}
