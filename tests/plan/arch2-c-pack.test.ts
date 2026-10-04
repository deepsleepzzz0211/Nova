import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorMessage } from '../../src/shared/errors.js';
import { matchDangerousCommand, DANGEROUS_PATTERNS } from '../../src/permission/dangerous.js';
import { loadDefinitionsFromDirs } from '../../src/shared/dir-definitions.js';

// arch2 ticket C: three duplications with one owner each - the unknown-error
// message expression (22 copies across src/), the dangerous-pattern loop
// (policy + permission-display walked DANGEROUS_PATTERNS themselves), and
// the two structurally identical definition-directory loaders.

describe('errorMessage', () => {
  it('Error -> message, string -> itself, other -> String()', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ k: 1 })).toBe('[object Object]');
  });
});

describe('matchDangerousCommand (single pattern-loop owner)', () => {
  it('returns the first matching reason', () => {
    const reason = matchDangerousCommand('rm -rf /');
    expect(reason).toBeTypeOf('string');
    // Same table the policy consulted before the extraction:
    const manual = DANGEROUS_PATTERNS.find(({ pattern }) => pattern.test('rm -rf /'))?.reason;
    expect(reason).toBe(manual);
  });

  it('returns null for a harmless command', () => {
    expect(matchDangerousCommand('pnpm test')).toBeNull();
  });

  it('empty command matches nothing', () => {
    expect(matchDangerousCommand('')).toBeNull();
  });
});

describe('loadDefinitionsFromDirs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'arch2-defs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  interface Thing {
    name: string;
  }
  const parseThing = (file: string, content: string): Thing | null =>
    content.startsWith('ok:') ? { name: `${file}:${content.slice(3)}` } : null;

  it('filters by extension, sorts, skips unparseable, and warns on unreadable entries', () => {
    fs.writeFileSync(path.join(dir, 'b.md'), 'ok:B');
    fs.writeFileSync(path.join(dir, 'a.md'), 'nope');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'ok:C');
    fs.mkdirSync(path.join(dir, 'd.md')); // directory masquerading as a .md file
    const warnings: string[] = [];
    const items = loadDefinitionsFromDirs<Thing>({
      dir,
      extension: '.md',
      warnTag: '[things]',
      warn: (m) => warnings.push(m),
      parse: parseThing,
    });
    expect(items.map((i) => i.name)).toEqual(['b.md:B']); // sorted, ext-filtered, unparseable skipped
    expect(warnings).toEqual(['[things] skipped d.md: unreadable']);
  });

  it('missing directory yields an empty list without warning', () => {
    const warnings: string[] = [];
    const items = loadDefinitionsFromDirs<Thing>({
      dir: path.join(dir, 'nope'),
      extension: '.md',
      warnTag: '[x]',
      warn: (m) => warnings.push(m),
      parse: parseThing,
    });
    expect(items).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
