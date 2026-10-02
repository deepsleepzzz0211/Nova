import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DirectoryInstructions } from '../../src/agent/directory-instructions.js';

// context-economics ticket 02: lazy, append-only per-directory AGENTS.md
// injection. Collection semantics pinned here: shallow-first chain, root
// excluded (already loaded as project instructions), inject-each-once,
// 32 KiB total budget truncating at the deepest end.

describe('DirectoryInstructions', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirinstr-'));
    fs.mkdirSync(path.join(root, 'packages', 'core', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT RULES');
    fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'PACKAGES RULES');
    fs.writeFileSync(path.join(root, 'packages', 'core', 'AGENTS.md'), 'CORE RULES');
    fs.writeFileSync(path.join(root, 'packages', 'core', 'src', 'CLAUDE.md'), 'SRC FALLBACK RULES');
    fs.writeFileSync(path.join(root, 'packages', 'core', 'src', 'a.ts'), 'x');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const rel = (list: { file: string }[]) => list.map((e) => path.relative(root, e.file).split('\\').join('/'));

  it('collects the chain shallow-first, skipping the root and missing dirs', () => {
    const di = new DirectoryInstructions({ rootDir: root });
    const pending = di.pendingFor(path.join(root, 'packages', 'core', 'src', 'a.ts'));
    expect(rel(pending)).toEqual([
      'packages/AGENTS.md',
      'packages/core/AGENTS.md',
      'packages/core/src/CLAUDE.md',
    ]);
  });

  it('each file injects exactly once; later reads return nothing new', () => {
    const di = new DirectoryInstructions({ rootDir: root });
    const first = di.pendingFor(path.join(root, 'packages', 'core', 'src', 'a.ts'));
    expect(first).toHaveLength(3);
    expect(di.pendingFor(path.join(root, 'packages', 'core', 'src', 'a.ts'))).toEqual([]);
    // A sibling under the same chain only yields nothing; a new subtree yields its own file.
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'AGENTS.md'), 'TOOLS');
    expect(rel(di.pendingFor(path.join(root, 'tools', 't.ts')))).toEqual(['tools/AGENTS.md']);
  });

  it('AGENTS.md wins over CLAUDE.md in the same directory', () => {
    fs.writeFileSync(path.join(root, 'packages', 'core', 'AGENTS.md'), 'CORE RULES');
    fs.writeFileSync(path.join(root, 'packages', 'core', 'CLAUDE.md'), 'CORE CLAUDE');
    const di = new DirectoryInstructions({ rootDir: root });
    const chain = di.pendingFor(path.join(root, 'packages', 'core', 'x.ts'));
    expect(chain.some((e) => e.file.endsWith('CLAUDE.md') && e.file.includes('core'))).toBe(false);
  });

  it('empty/whitespace instruction files are skipped but still marked visited', () => {
    fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), '   \n');
    const di = new DirectoryInstructions({ rootDir: root });
    expect(rel(di.pendingFor(path.join(root, 'packages', 'core', 'src', 'a.ts')))).toEqual([
      'packages/core/AGENTS.md',
      'packages/core/src/CLAUDE.md',
    ]);
    expect(di.pendingFor(path.join(root, 'packages', 'b.ts'))).toEqual([]);
  });

  it('32 KiB budget: deepest files truncate or drop with an explicit note', () => {
    // packages fills 30 KiB of the 32 KiB budget; core (4 KiB) crosses the
    // remaining 2 KiB and must truncate with a marker; src then sees zero
    // remaining and must drop with a note.
    fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'B'.repeat(30 * 1024));
    fs.writeFileSync(path.join(root, 'packages', 'core', 'AGENTS.md'), 'C'.repeat(4 * 1024));
    const di = new DirectoryInstructions({ rootDir: root, maxTotalBytes: 32 * 1024 });
    const pending = di.pendingFor(path.join(root, 'packages', 'core', 'src', 'a.ts'));
    expect(rel(pending)).toEqual([
      'packages/AGENTS.md',
      'packages/core/AGENTS.md',
      'packages/core/src/CLAUDE.md',
    ]);
    expect(pending[0].content).toBe('B'.repeat(30 * 1024));
    expect(pending[1].content).toMatch(/\[truncated at 32768-byte budget\]$/);
    expect(Buffer.byteLength(pending[1].content.split('\n')[0], 'utf-8')).toBe(2048);
    expect(pending[2].content).toMatch(/^\[dropped: budget exhausted/);
  });

  it('unreadable instruction file is skipped, never throws', () => {
    const dir = path.join(root, 'locked');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'X');
    fs.chmodSync(path.join(dir, 'AGENTS.md'), 0);
    const di = new DirectoryInstructions({ rootDir: root });
    expect(() => di.pendingFor(path.join(dir, 'f.ts'))).not.toThrow();
    fs.chmodSync(path.join(dir, 'AGENTS.md'), 0o644);
  });
});
