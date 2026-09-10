import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Slash-command and @-file completion support for the InputBar
 * (tui-refactor ticket 03). Pure logic + one async index builder; the
 * component maps key events onto this.
 */

/** Built-in slash commands (single source for the completion list). */
export const SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'model', description: 'list or switch models' },
  { name: 'undo', description: 'revert the last n conversation turns' },
  { name: 'compact', description: 'force a context compaction pass' },
  { name: 'update', description: 'update nova globally (takes effect on restart)' },
];

export type CompletionKind = 'slash' | 'file';

export interface CompletionContext {
  kind: CompletionKind;
  /** Query typed so far (after the trigger char). */
  query: string;
  /** Index in the text where the token (including the trigger char) starts. */
  tokenStart: number;
}

/**
 * Detect an active completion at the cursor: a leading `/command` or an
 * `@file` token. A slash command is only recognized at position 0 with no
 * whitespace before the cursor; an @ token must start at a word boundary
 * and its query must not contain whitespace.
 */
export function detectCompletion(text: string, cursor: number): CompletionContext | null {
  const before = text.slice(0, cursor);

  // Slash command: only at position 0, no whitespace before the cursor.
  if (text.startsWith('/') && cursor >= 1 && !/\s/.test(before)) {
    return { kind: 'slash', query: text.slice(1, cursor), tokenStart: 0 };
  }

  // @ file token: trigger char at a word boundary, no whitespace in query.
  const at = before.lastIndexOf('@');
  if (at !== -1) {
    const boundary = at === 0 || /\s/.test(text[at - 1]);
    const query = text.slice(at + 1, cursor);
    if (boundary && query.length === cursor - at - 1 && !/\s/.test(query)) {
      return { kind: 'file', query, tokenStart: at };
    }
  }

  return null;
}

/** Prefix-filter slash commands (case-insensitive). */
export function completeCommands(query: string): Array<{ name: string; description: string }> {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
}
// NOTE: SLASH_COMMANDS here and the string dispatch in useAgent.sendMessage
// must stay in sync until a shared command registry lands (tracked in the
// startup-header ticket).

/**
 * Fuzzy-match file paths: query chars must appear in order
 * (case-insensitive); scored with bonuses for consecutive and boundary
 * (after `/`, `\`, `.`, `_`, `-`, start) matches. Returns at most `limit`
 * (default 8) best matches; an empty query returns the first `limit` paths.
 */
export function fuzzyMatchFiles(files: ReadonlyArray<string>, query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const f = file.toLowerCase();
    let qi = 0;
    let score = 0;
    let lastMatchAt = -2;
    for (let i = 0; i < f.length && qi < q.length; i++) {
      if (f[i] !== q[qi]) continue;
      score += 1;
      if (i === lastMatchAt + 1) score += 2; // consecutive
      if (i === 0 || '/\\._-'.includes(f[i - 1])) score += 3; // boundary
      lastMatchAt = i;
      qi++;
    }
    if (qi === q.length) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((s) => s.file);
}

/** Directories skipped when building the file index. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.scratch', 'dist', 'build', 'coverage', '.idea']);

/** Walk `root` and return relative file paths (forward slashes), capped. */
export async function buildFileIndex(root: string, options?: { maxFiles?: number }): Promise<string[]> {
  const maxFiles = options?.maxFiles ?? 2000;
  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };

  await walk(root);
  return files;
}
