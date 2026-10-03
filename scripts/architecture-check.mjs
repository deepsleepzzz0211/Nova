#!/usr/bin/env node
/**
 * Architecture ratchet check (zcode-borrow ticket 07) — a dependency-free
 * mini linter over `src/` that enforces three rules and RATCHETS them: a
 * fingerprinted baseline records existing debt, and only NEW violations fail
 * the run. Paying down debt = deleting entries from the baseline.
 *
 *   1. maxFileLines   — a source file may not exceed a line cap.
 *   2. noCycles       — top-level modules must not import each other cyclically.
 *   3. noDeepImports  — a cross-module import may only target that module's
 *                       public surface: `<module>/index.ts` or a file directly
 *                       under `<module>/`. Importing another module's internal
 *                       sub-directory files is a deep import.
 *   4. maxPublicSurface — a file may export at most 12 top-level declarations
 *                       (interface width IS the debt the deep-module rounds
 *                       kept finding; arch ticket 05).
 *   5. suppressions   — any file containing @ts-ignore/@ts-expect-error/
 *                       eslint-disable carries a fingerprint until cleaned.
 *
 * Baseline entries are either plain strings (accepted debt) or objects
 * `{ id, expires }`: an expired exception stops counting, so debt cannot
 * outlive its agreed review date (arch ticket 05).
 *
 * Exit codes: 0 = no new violations, 1 = new violations (or read error).
 *
 *   node scripts/architecture-check.mjs            # check against baseline
 *   node scripts/architecture-check.mjs --update   # re-pin baseline (record debt)
 *   node scripts/architecture-check.mjs --changed main  # only files in the
 *       reverse-import closure of `git diff main...HEAD -- src` (+ global
 *       cycle checks); local convenience, CI always runs the full check.
 *   node scripts/architecture-check.mjs --baseline <path> --src <path>
 *
 * The pure analysis (`collectViolations`) is exported so tests can run it over
 * fixture trees without touching the real repository.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_MAX_FILE_LINES = 400;
const DEFAULT_MAX_PUBLIC_SURFACE = 12;

/** Top-level export declarations a caller must cross to use this module. */
function publicExportCount(content) {
  let count = 0;
  for (const line of content.split('\n')) {
    if (/^export\s+(?:default\s+)?(?:async\s+)?(const|let|function|class|interface|type|enum)\b/.test(line)) count++;
    else if (/^export\s*\{/.test(line)) count++;
  }
  return count;
}

/** AGENTS forbids naked suppressions; the ratchet makes them countable debt. */
const SUPPRESSION_RE = /@ts-(?:ignore|expect-error)|eslint-disable/;

/** Source extensions considered part of a module (tests/build excluded elsewhere). */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Recursively list files under `dir` (absolute paths), skipping noise. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Every `from '...'` / `import '...'` specifier in a source file. */
function importSpecifiers(content) {
  const specs = [];
  const re = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) specs.push(m[1]);
  return specs;
}

/** Top-level module name for a src-relative posix path, or null (loose file). */
function moduleOf(relPosix) {
  const parts = relPosix.split('/');
  return parts.length > 1 ? parts[0] : null;
}

/** Strip extension + normalize to posix. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

function withoutExt(relPosix) {
  return relPosix.replace(/\.(ts|tsx)$/, '');
}

/**
 * Resolve a relative import specifier from `fromRel` (src-relative posix) to a
 * src-relative posix path of the target file, if it lives inside `src`.
 * Bare (package) specifiers resolve outside src → null.
 */
function resolveImport(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const baseDir = path.posix.dirname(fromRel);
  let target = path.posix.normalize(path.posix.join(baseDir, spec));
  target = withoutExt(target);
  return target;
}

/**
 * Analyze a `src` tree and return the sorted set of violation fingerprints.
 * @param {string} srcDir absolute path to the source root to analyze
 * @param {{ maxFileLines?: number }} [config]
 * @returns {string[]} fingerprints like `maxFileLines:<rel>`, `cycle:<a>..<b>`,
 *                    `deepImport:<from>-><to>`
 */
export function collectViolations(srcDir, config = {}) {
  const maxFileLines = config.maxFileLines ?? DEFAULT_MAX_FILE_LINES;
  const maxPublicSurface = config.maxPublicSurface ?? DEFAULT_MAX_PUBLIC_SURFACE;
  const files = walk(srcDir).map((abs) => ({
    abs,
    rel: toPosix(path.relative(srcDir, abs)),
  }));

  const violations = new Set();

  // 1. file length cap; 4. public surface cap; 5. suppression presence.
  for (const { abs, rel } of files) {
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lineCount = content.split('\n').length;
    if (lineCount > maxFileLines) violations.add(`maxFileLines:${rel}`);
    if (publicExportCount(content) > maxPublicSurface) violations.add(`maxPublicSurface:${rel}`);
    if (SUPPRESSION_RE.test(content)) violations.add(`suppressions:${rel}`);
  }

  // Collect cross-module edges (module level) and per-file deep imports.
  /** @type {Map<string, Set<string>>} */
  const moduleEdges = new Map();
  const addEdge = (from, to) => {
    if (from === to) return;
    if (!moduleEdges.has(from)) moduleEdges.set(from, new Set());
    moduleEdges.get(from).add(to);
  };

  for (const { abs, rel } of files) {
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const fromModule = moduleOf(rel);
    for (const spec of importSpecifiers(content)) {
      const resolved = resolveImport(rel, spec);
      if (resolved === null) continue;
      const toModule = moduleOf(resolved);
      if (toModule === null) continue; // loose file at src root
      if (fromModule !== null && toModule !== fromModule) {
        addEdge(fromModule, toModule);
        // 3. deep import: entering another module below its public surface.
        const inTarget = resolved.split('/').slice(1); // segments after the module
        const isIndex = inTarget.length === 1 && (inTarget[0] === 'index');
        const isTopLevel = inTarget.length === 1; // <module>/<file>
        if (!isTopLevel && !isIndex) {
          violations.add(`deepImport:${rel}->${resolved}`);
        }
      }
    }
  }

  // 2. cycles among modules (DFS; report each cyclic module pair once).
  const cycles = findModuleCycles(moduleEdges);
  for (const c of cycles) violations.add(`cycle:${c}`);

  return [...violations].sort();
}

/** Find module-level cycles; returns canonical "a..b..a" signatures. */
function findModuleCycles(edges) {
  const signatures = new Set();
  const visited = new Set();
  const stack = [];
  const onStack = new Set();

  const dfs = (node) => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (onStack.has(next)) {
        const start = stack.indexOf(next);
        const cycleModules = stack.slice(start);
        signatures.add(canonicalCycleSignature(cycleModules, edges));
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const node of edges.keys()) {
    if (!visited.has(node)) dfs(node);
  }
  return signatures;
}

/** Rotate a cycle to its lexicographically smallest member, so A->B->A and
 * B->A->B collapse to one signature. */
function canonicalCycleSignature(modules, edges) {
  let start = 0;
  for (let i = 1; i < modules.length; i++) {
    if (modules[i] < modules[start]) start = i;
  }
  const rotated = [...modules.slice(start), ...modules.slice(0, start)];
  return [...rotated, rotated[0]].join('..');
}

function readBaseline(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed.violations) ? parsed.violations : [];
  } catch {
    return [];
  }
}

/** Baseline entry id: plain strings, or `{ id, expires }` exception objects. */
export function baselineIds(entries) {
  return entries.map((e) => (typeof e === 'string' ? e : e.id));
}

/** Exceptions whose `expires` date has passed (today = YYYY-MM-DD). */
export function expiredExceptions(entries, today) {
  const out = [];
  for (const e of entries) {
    if (typeof e !== 'string' && typeof e.expires === 'string' && e.expires < today) {
      out.push({ id: e.id, expires: e.expires });
    }
  }
  return out;
}

/** The src-relative file a fingerprint is about, or null for global checks. */
export function violationFile(violation) {
  if (violation.startsWith('cycle:')) return null;
  const rest = violation.slice(violation.indexOf(':') + 1);
  return violation.startsWith('deepImport:') ? rest.split('->')[0] : rest;
}

/**
 * Transitive reverse-import closure of `changed` (imports: file -> imported
 * files; all keys/values must be in the same normalized form). A change to
 * c.ts forces a re-check of everything that (transitively) imports it.
 */
export function changedClosure(imports, changed) {
  const reverse = new Map();
  for (const [from, tos] of Object.entries(imports)) {
    for (const to of tos) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
  }
  const out = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    for (const dependent of reverse.get(queue.shift()) ?? []) {
      if (!out.has(dependent)) {
        out.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return out;
}

/** file -> src-internal import targets (extension-stripped keys). */
export function collectImportGraph(srcDir) {
  const files = walk(srcDir).map((abs) => ({
    abs,
    rel: toPosix(path.relative(srcDir, abs)),
  }));
  const known = new Set(files.map((f) => withoutExt(f.rel)));
  const graph = {};
  for (const { abs, rel } of files) {
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const key = withoutExt(rel);
    if (graph[key] === undefined) graph[key] = [];
    for (const spec of importSpecifiers(content)) {
      const resolved = resolveImport(rel, spec);
      if (resolved !== null && known.has(resolved)) graph[key].push(resolved);
    }
  }
  return graph;
}

/**
 * The ratchet: only violations absent from the baseline are actionable.
 * Exported so tests can assert the "new vs baselined" split directly.
 */
export function selectNewViolations(current, baseline) {
  const known = new Set(baseline);
  return current.filter((v) => !known.has(v));
}

function writeBaseline(file, violations) {
  fs.writeFileSync(
    file,
    `${JSON.stringify({ version: 1, violations: [...violations].sort() }, null, 2)}\n`,
    'utf-8',
  );
}

function parseArgs(argv) {
  const opts = { update: false, src: null, baseline: null, changed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') opts.update = true;
    else if (a === '--src') opts.src = argv[++i];
    else if (a === '--baseline') opts.baseline = argv[++i];
    else if (a === '--changed') opts.changed = argv[++i];
  }
  return opts;
}

function changedFilesFromGit(baseRef) {
  const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`, '--', 'src'], {
    encoding: 'utf-8',
  });
  return out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => toPosix(path.relative('src', path.resolve('.', l))));
}

function main() {
  const repoRoot = path.resolve('.');
  const opts = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(repoRoot, opts.src ?? 'src');
  const baselinePath = path.resolve(repoRoot, opts.baseline ?? '.architecture-baseline.json');

  const current = collectViolations(srcDir);
  const currentSet = new Set(current);

  if (opts.update) {
    writeBaseline(baselinePath, current);
    console.log(`architecture baseline written: ${current.length} violation(s) recorded.`);
    process.exit(0);
  }

  const entries = readBaseline(baselinePath);
  const today = new Date().toISOString().slice(0, 10);
  const expired = expiredExceptions(entries, today);
  const expiredIds = new Set(expired.map((e) => e.id));
  const known = new Set(baselineIds(entries).filter((id) => !expiredIds.has(id)));
  let newViolations = selectNewViolations(current, [...known]);

  // --changed: keep file-scoped findings inside the reverse-import closure of
  // the diff; global findings (cycles) and expired exceptions always count.
  if (opts.changed !== null) {
    const closure = changedClosure(collectImportGraph(srcDir), changedFilesFromGit(opts.changed));
    newViolations = newViolations.filter((v) => {
      const file = violationFile(v);
      return file === null || closure.has(withoutExt(file));
    });
  }

  let failed = false;
  if (expired.length > 0) {
    console.error(`ARCHITECTURE CHECK FAILED — ${expired.length} expired exception(s):\n`);
    for (const e of expired) console.error(`  EXPIRED ${e.id} (since ${e.expires}) — re-decide: renew or fix`);
    failed = true;
  }
  if (newViolations.length > 0) {
    console.error(`ARCHITECTURE CHECK FAILED — ${newViolations.length} new violation(s):\n`);
    for (const v of newViolations) console.error(`  ${v}`);
    console.error('\nFix the new violation, or if it is accepted debt, run');
    console.error('  node scripts/architecture-check.mjs --update');
    console.error('and commit the enlarged baseline (use {id, expires} entries for time-boxed exceptions).');
    failed = true;
  }
  if (failed) process.exit(1);

  const summary = `architecture OK — ${current.length} total violation(s), ${known.size} baselined`;
  console.log(repaidCount(known, currentSet) > 0 ? `${summary}, ${repaidCount(known, currentSet)} resolved (debt repaid — run --update)` : summary);
}

function repaidCount(known, currentSet) {
  let n = 0;
  for (const v of known) if (!currentSet.has(v)) n++;
  return n;
}

// Run as a CLI only when invoked directly, so tests can import collectViolations.
if (process.argv[1] && toPosix(process.argv[1]).endsWith('scripts/architecture-check.mjs')) {
  main();
}
