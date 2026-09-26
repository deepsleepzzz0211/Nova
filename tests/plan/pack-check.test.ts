import { describe, it, expect } from 'vitest';
import { inspectPack } from '../../scripts/pack-check.mjs';

// p1-p2 02: the PR-level publish rehearsal asserts WHAT the published tarball
// must and must not contain before any tag exists. inspectPack is the pure
// judgement; the script's I/O wrapper runs `npm pack --json` around it.

const okFiles = [
  { path: 'package.json' },
  { path: 'dist/index.js' },
  { path: 'dist/index.js.map' },
];

interface PackFile { path: string }

const packOf = (files: PackFile[]) => ({
  name: '@posuiqianqiu/nova',
  version: '0.3.0',
  filename: 'posuiqianqiu-nova-0.3.0.tgz',
  files: files.map((f) => ({ path: f.path, size: 100 })),
  entry: 'dist/index.js',
});

describe('inspectPack (p1-p2 02)', () => {
  it('accepts a healthy pack: bin target present, nothing forbidden', () => {
    expect(inspectPack(packOf(okFiles), { bin: './dist/index.js' })).toEqual([]);
  });

  it('flags a missing build artifact (the beta-era file-inclusion failure)', () => {
    const violations = inspectPack(
      packOf([{ path: 'package.json' }]),
      { bin: './dist/index.js' },
    );
    expect(violations.join('\n')).toMatch(/dist\/index\.js/);
  });

  it('flags a bin target that is not in the pack at all', () => {
    const violations = inspectPack(packOf(okFiles), { bin: './dist/ghost.js' });
    expect(violations.join('\n')).toMatch(/ghost/);
  });

  it('flags forbidden directories leaking into the tarball', () => {
    const violations = inspectPack(
      packOf([...okFiles, { path: 'tests/plan/x.test.ts' }, { path: '.scratch/y' }]),
      { bin: './dist/index.js' },
    );
    expect(violations.join('\n')).toMatch(/tests/);
    expect(violations.join('\n')).toMatch(/\.scratch/);
  });

  it('flags an empty pack', () => {
    const violations = inspectPack(packOf([]), { bin: './dist/index.js' });
    expect(violations.length).toBeGreaterThan(0);
  });
});
