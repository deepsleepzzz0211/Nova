import * as path from 'path';

/**
 * Path discipline shared by the memory pipeline (ticket 04/05 review fix):
 * ONE containment definition so the scheduler's direct-write detection and
 * the extraction agent's confined tools can never drift apart.
 */

function normalizeAbs(p: string, cwd: string): string {
  return path.resolve(cwd, p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Is `raw` (relative or absolute, any slash style) inside one of `dirs`? */
export function isWithinDirs(raw: string, dirs: readonly string[], cwd: string): boolean {
  if (!raw) return false;
  const target = normalizeAbs(raw, cwd);
  return dirs.some((dir) => {
    const base = normalizeAbs(dir, cwd);
    return target === base || target.startsWith(`${base}/`);
  });
}
