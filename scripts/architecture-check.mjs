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
 *
 * Exit codes: 0 = no new violations, 1 = new violations (or read error).
 *
 *   node scripts/architecture-check.mjs            # check against baseline
 *   node scripts/architecture-check.mjs --update   # re-pin baseline (record debt)
 *   node scripts/architecture-check.mjs --baseline <path> --src <path>
 *
 * The pure analysis (`collectViolations`) is exported so tests can run it over
 * fixture trees without touching the real repository.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_MAX_FILE_LINES = 400;

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
  const files = walk(srcDir).map((abs) => ({
    abs,
    rel: toPosix(path.relative(srcDir, abs)),
  }));

  const violations = new Set();

  // 1. file length cap
  for (const { abs, rel } of files) {
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lineCount = content.split('\n').length;
    if (lineCount > maxFileLines) violations.add(`maxFileLines:${rel}`);
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
  const opts = { update: false, src: null, baseline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') opts.update = true;
    else if (a === '--src') opts.src = argv[++i];
    else if (a === '--baseline') opts.baseline = argv[++i];
  }
  return opts;
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

  const known = new Set(readBaseline(baselinePath));
  const newViolations = selectNewViolations(current, [...known]);
  const repaid = [...known].filter((v) => !currentSet.has(v));

  if (newViolations.length > 0) {
    console.error(`ARCHITECTURE CHECK FAILED — ${newViolations.length} new violation(s):\n`);
    for (const v of newViolations) console.error(`  ${v}`);
    console.error('\nFix the new violation, or if it is accepted debt, run');
    console.error('  node scripts/architecture-check.mjs --update');
    console.error('and commit the enlarged baseline.');
    process.exit(1);
  }

  const summary = `architecture OK — ${current.length} total violation(s), ${known.size} baselined`;
  console.log(repaid.length > 0 ? `${summary}, ${repaid.length} resolved (debt repaid — run --update)` : summary);
}

// Run as a CLI only when invoked directly, so tests can import collectViolations.
if (process.argv[1] && toPosix(process.argv[1]).endsWith('scripts/architecture-check.mjs')) {
  main();
}
