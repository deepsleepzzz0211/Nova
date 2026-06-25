/**
 * Skill registry — discovers, indexes, and resolves skill definitions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSkillMd } from './loader.js';

/** Metadata for a discovered skill (does not include the full body). */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
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
   */
  async scan(dir: string): Promise<void> {
    this.skills = [];
    this.walkDir(dir);
  }

  private walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
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
