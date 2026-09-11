import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Source hygiene guard.
 *
 * Inline script heredocs silently swallow one level of backslash escapes,
 * which repeatedly wrote RAW control bytes into source files (eight times
 * during the TUI refactor: real ESC/CR bytes broke parsing, and a replace
 * whose pattern no longer matched failed silently). This test fails loudly
 * if a source file contains raw control characters, so the class of mistake
 * cannot reach a commit again.
 *
 * Allowed: tab (0x09), LF (0x0A), and CR (0x0D) only as part of CRLF line
 * endings (the Windows working tree checks out CRLF). Anything else -- a
 * lone CR, ESC (0x1B), or any other C0 control -- fails the test.
 */
const ROOTS = ['src', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('source hygiene (no raw control bytes)', () => {
  it('source files contain no raw control characters', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const text = fs.readFileSync(file, 'utf-8');
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if (code === 0x09 || code === 0x0a) continue;
          if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue; // CRLF
          if (code < 0x20 || code === 0x7f) {
            const line = text.slice(0, i).split('\n').length;
            offenders.push(`${file}:${line} (0x${code.toString(16)})`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
