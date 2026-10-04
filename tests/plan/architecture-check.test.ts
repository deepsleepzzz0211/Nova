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
  collectViolations: (
    srcDir: string,
    config?: { maxFileLines?: number; maxPublicSurface?: number },
  ) => string[];
  selectNewViolations: (current: string[], baseline: string[]) => string[];
  expiredExceptions: (
    entries: Array<string | { id: string; expires?: string }>,
    today: string,
  ) => Array<{ id: string; expires: string }>;
  baselineIds: (
    entries: Array<string | { id: string; expires?: string }>,
  ) => string[];
  violationFile: (violation: string) => string | null;
  changedClosure: (imports: Record<string, string[]>, changed: string[]) => Set<string>;
  mergeBaseline: (
    current: string[],
    prior: Array<string | { id: string; expires?: string }>,
  ) => Array<string | { id: string; expires?: string }>;
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

  it('expired exceptions leave the active set and are reported', () => {
    const entries = [
      'maxFileLines:a.ts',
      { id: 'maxPublicSurface:b.ts', expires: '2026-01-01' },
      { id: 'suppressions:c.ts', expires: '2099-01-01' },
      { id: 'cycle:x..y' }, // no expiry: never expires
    ];
    expect(arch.baselineIds(entries)).toEqual([
      'maxFileLines:a.ts',
      'maxPublicSurface:b.ts',
      'suppressions:c.ts',
      'cycle:x..y',
    ]);
    expect(arch.expiredExceptions(entries, '2026-10-03')).toEqual([
      { id: 'maxPublicSurface:b.ts', expires: '2026-01-01' },
    ]);
  });
});

describe('architecture-check public-surface & suppression rules', () => {
  let src: string;
  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-rule-'));
  });
  afterEach(() => fs.rmSync(src, { recursive: true, force: true }));

  it('flags files exporting more than the public-surface cap', () => {
    const many = Array.from({ length: 13 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    write(src, 'wide/w.ts', `${many}\n`);
    write(src, 'narrow/n.ts', 'export const a = 1;\nexport const b = 2;\n');
    const v = arch.collectViolations(src, { maxFileLines: 500, maxPublicSurface: 12 });
    expect(v).toContain('maxPublicSurface:wide/w.ts');
    expect(v).not.toContain('maxPublicSurface:narrow/n.ts');
  });

  it('type-only exports and commented exports do not count', () => {
    const body = [
      '// export const docs = 1;',
      'export type Alias = number;',
      'export interface Iface { a(): void }',
      'const real = 1;',
      'export { real };',
    ].join('\n');
    write(src, 'mix/m.ts', `${body}\n`);
    const v = arch.collectViolations(src, { maxFileLines: 500, maxPublicSurface: 12 });
    expect(v).not.toContain('maxPublicSurface:mix/m.ts');
  });

  it('flags any file carrying suppressions (ts-ignore / eslint-disable)', () => {
    write(src, 'clean/c.ts', 'export const a = 1;\n');
    write(src, 'dirty/d.ts', '// @ts-expect-error justified\nexport const b: number = 1;\n');
    write(src, 'dirty/e.ts', '/* eslint-disable no-console */\nexport const c = 1;\n');
    const v = arch.collectViolations(src, { maxFileLines: 500, maxPublicSurface: 50 });
    expect(v).toContain('suppressions:dirty/d.ts');
    expect(v).toContain('suppressions:dirty/e.ts');
    expect(v).not.toContain('suppressions:clean/c.ts');
  });
});

describe('architecture-check --changed closure', () => {
  it('walks the reverse import graph (importers of what changed) transitively', () => {
    // a imports b, b imports c: changing c forces a re-check of b (imports c)
    // and a (imports the changed closure). d is unrelated.
    const imports = { 'a.ts': ['b.ts'], 'b.ts': ['c.ts'], 'c.ts': [], 'd.ts': [] };
    const closure = arch.changedClosure(imports, ['c.ts']);
    expect([...closure].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('maps a violation fingerprint to its file (cycles are global)', () => {
    expect(arch.violationFile('maxFileLines:big/one.ts')).toBe('big/one.ts');
    expect(arch.violationFile('deepImport:a/x.ts->b/y.ts')).toBe('a/x.ts');
    expect(arch.violationFile('suppressions:d.ts')).toBe('d.ts');
    expect(arch.violationFile('cycle:m1..m2..m1')).toBeNull(); // always checked
  });
});

describe('architecture-check baseline re-pin preserves exception metadata', () => {
  it('keeps {id,expires} for still-violating ids, adds new as strings, drops repaid', () => {
    const prior = [
      { id: 'a', expires: '2026-12-31' },
      'b',
      { id: 'c', expires: '2026-12-31' },
    ];
    const current = ['a', 'b', 'd']; // c repaid (dropped), d newly baselined
    expect(arch.mergeBaseline(current, prior)).toEqual([
      { id: 'a', expires: '2026-12-31' }, // exception object survives
      'b',
      'd', // new plain entry
    ]);
  });

  it('is stable when current and prior already agree (idempotent re-pin)', () => {
    const entries = [{ id: 'x', expires: '2027-01-01' }];
    expect(arch.mergeBaseline(['x'], entries)).toEqual(entries);
  });
});
