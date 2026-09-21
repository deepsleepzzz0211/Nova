import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The checker is a dependency-free .mjs (not typechecked with src); load it via
// require(esm) so this test exercises the real script, not a copy.
const require = createRequire(import.meta.url);
const modUrl = fileURLToPath(new URL('../../scripts/architecture-check.mjs', import.meta.url));

interface ArchModule {
  collectViolations: (srcDir: string, config?: { maxFileLines?: number }) => string[];
  selectNewViolations: (current: string[], baseline: string[]) => string[];
}

const arch = require(modUrl) as ArchModule;

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('architecture-check collectViolations', () => {
  let src: string;
  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  });
  afterEach(() => fs.rmSync(src, { recursive: true, force: true }));

  it('a clean tree reports nothing', () => {
    write(src, 'alpha/index.ts', `import { x } from 'beta';\nexport const x = x;\n`);
    write(src, 'beta/index.ts', `export const y = 1;\n`);
    // beta is a bare specifier here (package import) — ignored by the resolver.
    expect(arch.collectViolations(src, { maxFileLines: 50 })).toEqual([]);
  });

  it('flags files over the line cap', () => {
    write(src, 'big/one.ts', Array.from({ length: 6 }, (_, i) => `// line ${i}`).join('\n'));
    write(src, 'small/two.ts', '// only\n// two\n');
    const v = arch.collectViolations(src, { maxFileLines: 5 });
    expect(v).toContain('maxFileLines:big/one.ts');
    expect(v).not.toContain('maxFileLines:small/two.ts');
  });

  it('flags a cross-module deep import but not a public-surface import', () => {
    // consumer reaches into provider's internal sub-directory file.
    write(src, 'consumer/app.ts', `import { z } from '../provider/internal/deep.js';\nvoid z;\n`);
    write(src, 'provider/internal/deep.ts', `export const z = 1;\n`);
    // and a legal import of a top-level module file:
    write(src, 'other/ok.ts', `import { a } from '../provider/top.js';\nvoid a;\n`);
    write(src, 'provider/top.ts', `export const a = 1;\n`);
    const v = arch.collectViolations(src, { maxFileLines: 50 });
    expect(v.some((f) => f.startsWith('deepImport:consumer/app.ts->provider/internal/deep'))).toBe(true);
    expect(v.some((f) => f.startsWith('deepImport:other/ok.ts'))).toBe(false);
  });

  it('detects a module dependency cycle', () => {
    write(src, 'm1/a.ts', `import '../m2/b.js';\n`);
    write(src, 'm2/b.ts', `import '../m1/a.js';\n`);
    const v = arch.collectViolations(src, { maxFileLines: 50 });
    expect(v.some((f) => f.startsWith('cycle:'))).toBe(true);
    expect(v.some((f) => f.includes('m1') && f.includes('m2'))).toBe(true);
  });

  it('no cycle for a one-way dependency', () => {
    write(src, 'x/a.ts', `import '../y/b.js';\n`);
    write(src, 'y/b.ts', `export const b = 1;\n`);
    expect(arch.collectViolations(src, { maxFileLines: 50 }).filter((f) => f.startsWith('cycle:'))).toEqual([]);
  });
});

describe('architecture-check ratchet', () => {
  it('only violations absent from the baseline are actionable', () => {
    const current = ['maxFileLines:a.ts', 'deepImport:b.ts->c/d.ts'];
    const baseline = ['maxFileLines:a.ts'];
    expect(arch.selectNewViolations(current, baseline)).toEqual(['deepImport:b.ts->c/d.ts']);
    expect(arch.selectNewViolations(current, current)).toEqual([]);
  });
});
