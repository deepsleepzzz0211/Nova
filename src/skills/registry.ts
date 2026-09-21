/**
 * Skill registry — discovers, indexes, and resolves skill definitions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSkillMd } from './loader.js';
import { lockDirFor, readSkillLock, verifySkillFile } from './skill-lock.js';

/** Metadata for a discovered skill (does not include the full body). */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/** Options for {@link SkillRegistry.scan}. */
export interface ScanOptions {
  /**
   * Called for each skill refused by an integrity lock (drift / unpinned).
   * Diagnostics channel is the caller's choice (stderr in the CLI).
   */
  onWarn?: (message: string) => void;
  /** Enforce `.skills-lock.json` integrity for locked repos. Default true. */
  enforceLocks?: boolean;
}

/** Tokenize a string into lowercased word tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`~@#$%^&*+=/\\|<>-]+/)
    .filter((t) => t.length > 0);
}

export class SkillRegistry {
  private skills: SkillMeta[] = [];

  /**
   * Walk `dir` recursively, looking for `SKILL.md` files.
   * Each file is parsed; its frontmatter becomes a registry entry.
   * When a discovered skill sits under a `.skills-lock.json`, it is loaded
   * only if its bytes match the pinned hash; drift/unpinned skills are
   * refused and reported through `onWarn`. Rescanning replaces the index.
   */
  async scan(dir: string, options: ScanOptions = {}): Promise<void> {
    this.skills = [];
    this.walkDir(dir, dir, options);
  }

  private walkDir(dir: string, root: string, options: ScanOptions): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const enforceLocks = options.enforceLocks ?? true;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(full, root, options);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        if (enforceLocks && this.isBlockedByLock(full, root, options.onWarn)) {
          continue;
        }
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const parsed = parseSkillMd(raw);
          this.skills.push({
            name: parsed.name,
            description: parsed.description,
            path: full,
          });
        } catch {
          // Skip malformed SKILL.md files silently.
        }
      }
    }
  }

  /**
   * True when the skill sits under a lock and fails it (drifted or added
   * without a lock entry). Reports through onWarn. Skills with no enclosing
   * lock return false (unlocked repos stay fully trusted as before).
   */
  private isBlockedByLock(skillFile: string, root: string, onWarn?: (m: string) => void): boolean {
    const lockDir = lockDirFor(skillFile, root);
    if (!lockDir) return false;
    const lockPath = path.join(lockDir, '.skills-lock.json');
    const lock = readSkillLock(lockPath);
    const rel = path.relative(root, skillFile).split(path.sep).join('/');
    // A lock file exists (lockDirFor guarantees it) but cannot be parsed:
    // fail CLOSED — refuse rather than silently trust a corrupted pin.
    if (!lock) {
      onWarn?.(`[skills-lock] refused ${rel}: the lock file at ${lockDir} is unreadable or malformed`);
      return true;
    }
    const verdict = verifySkillFile(lockDir, skillFile, lock);
    if (verdict.status === 'match') return false;
    if (verdict.status === 'drift') {
      onWarn?.(
        `[skills-lock] refused ${rel}: content hash drifted from the lock (expected ${verdict.expected.slice(0, 12)}…, got ${verdict.actual.slice(0, 12)}…)`,
      );
    } else {
      onWarn?.(
        `[skills-lock] refused ${rel}: no lock entry — a locked repo skill must be re-pinned (writeSkillLock) before it loads`,
      );
    }
    return true;
  }

  /** Return all discovered skills. */
  findAll(): SkillMeta[] {
    return [...this.skills];
  }

  /** Exact name lookup. */
  find(name: string): SkillMeta | undefined {
    return this.skills.find((s) => s.name === name);
  }

  /**
   * Keyword search across skill names and descriptions.
   * Tokenizes both the query and each skill's name + description,
   * returning skills with ≥ 2 overlapping tokens.
   * Matching uses prefix comparison so "error" matches "errors",
   * and "debug" matches "debugging".
   */
  findByKeywords(query: string): SkillMeta[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    return this.skills.filter((skill) => {
      const skillTokens = tokenize(`${skill.name} ${skill.description}`);
      const overlap = queryTokens.filter((qt) =>
        skillTokens.some((st) => st.startsWith(qt) || qt.startsWith(st)),
      ).length;
      return overlap >= 2;
    });
  }

  /** Read and return the full SKILL.md content for a given skill. */
  async load(skill: SkillMeta): Promise<string> {
    return fs.readFileSync(skill.path, 'utf-8');
  }
}
