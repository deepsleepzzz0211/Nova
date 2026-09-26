#!/usr/bin/env node
/**
 * PR-level publish rehearsal (p1-p2 02): assert the tarball npm WOULD ship
 * is shippable — bin target present, no dev/secret dirs leaking — before any
 * tag exists. The beta.0/1/2 era taught that file-inclusion surprises only
 * surface at publish time; this closes that gap at PR cost (a few seconds).
 *
 *   node scripts/pack-check.mjs            # npm pack --json + judge + cleanup
 *   inspectPack(meta, pkg)                # pure judgement, unit-tested
 *
 * Exit codes: 0 = pack healthy, 1 = violations (printed as [PACK] lines).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directories/files that must NEVER appear in the published tarball. */
const FORBIDDEN = ['tests/', 'src/', '.scratch/', 'docs/', 'node_modules/', '.env', 'config.toml'];

/**
 * @param {object} meta npm pack --json entry (files, name, version, filename)
 * @param {{ bin?: string | Record<string,string> }} pkg package.json fragment
 * @returns {string[]} human-readable violations ([] = healthy)
 */
export function inspectPack(meta, pkg) {
  const violations = [];
  const paths = (meta.files ?? []).map((f) => f.path);
  if (paths.length === 0) {
    violations.push('pack contains no files at all');
    return violations;
  }
  if (!paths.includes('package.json')) violations.push('package.json missing from pack');

  const binTargets = typeof pkg.bin === 'string'
    ? [pkg.bin]
    : Object.values(pkg.bin ?? {});
  for (const target of binTargets) {
    const rel = target.replace(/^\.\//, '');
    if (!paths.includes(rel)) {
      violations.push(`bin target "${rel}" is not in the pack (would install a broken command)`);
    }
  }

  for (const bad of FORBIDDEN) {
    const leaked = paths.filter((p) => p === bad || p.startsWith(bad));
    if (leaked.length > 0) {
      violations.push(`forbidden path(s) in pack: ${leaked.slice(0, 3).join(', ')}${leaked.length > 3 ? ` (+${leaked.length - 3} more)` : ''}`);
    }
  }
  return violations;
}

function main() {
  // Windows ships npm as npm.cmd; spawning a .cmd requires a shell (Node
  // EINVALs otherwise). Args here are constants — no user input in the
  // command string.
  const packJson = execFileSync('npm', ['pack', '--json'], {
    shell: process.platform === 'win32',
    cwd: process.cwd(),
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const [meta] = JSON.parse(packJson);
  if (!meta) {
    console.error('[PACK] npm pack --json returned nothing');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
  const violations = inspectPack(meta, pkg);
  const keep = process.argv.includes('--keep');

  try {
    if (violations.length > 0) {
      console.error(`[PACK] FAILED — ${violations.length} violation(s):`);
      for (const v of violations) console.error(`  ${v}`);
      process.exit(1);
    }
    console.log(`[PACK] OK — ${meta.filename}: ${meta.files.length} file(s), bin wired`);
    // Keep the tarball for the caller (the smoke step installs it).
    console.log(`[PACK] TARBALL=${meta.filename}`);
  } finally {
    // Only clean up on success without --keep; on failure the artifact aids
    // debugging, and with --keep the caller consumes the tarball.
    if (violations.length === 0 && !keep) fs.rmSync(path.resolve(meta.filename), { force: true });
  }
}

// Run as CLI only when invoked directly (tests import inspectPack).
if (process.argv[1] && process.argv[1].split(path.sep).join('/').endsWith('scripts/pack-check.mjs')) {
  main();
}
