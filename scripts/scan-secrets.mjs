#!/usr/bin/env node
/**
 * Pre-publish secret scanner (release gate).
 *
 * Scans what a version tag actually publishes:
 *   1. the HEAD working tree (all tracked files)
 *   2. the ENTIRE git history (a tag carries every commit)
 *
 * Detection is by well-known token prefixes with minimum lengths chosen so
 * that test fixtures (sk-test / tvly-x / tvly-test / sk-abc123) never match.
 * The scanner excludes its own file: its regex sources contain token-prefix
 * literals by definition.
 *
 * Exit codes: 0 = clean, 1 = secret-like material found (or git error).
 * Usage: node scripts/scan-secrets.mjs [repoRoot]   (default: cwd)
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? '.');
const SELF_RELATIVE = 'scripts/scan-secrets.mjs';

const PATTERNS = [
  { name: 'OpenAI/OpenCode-style key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Tavily key', re: /tvly-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub classic token', re: /gh[posur]_[A-Za-z0-9]{20,}/ },
  { name: 'npm token', re: /npm_[A-Za-z0-9]{20,}/ },
];

const findings = [];

function redact(match) {
  return match.length <= 10 ? '***' : `${match.slice(0, 6)}...${match.slice(-4)} (redacted, len ${match.length})`;
}

function report(file, line, patternName, match) {
  findings.push(`  ${file}:${line ?? '?'} — ${patternName}: ${redact(match)}`);
}

function scanContent(relFile, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      const m = re.exec(lines[i]);
      if (m) report(relFile, i + 1, name, m[0]);
    }
  }
}

function git(args) {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// ---- 1. HEAD working tree (tracked files only) ----
const tracked = git('ls-files').split('\n').filter((f) => f && f !== SELF_RELATIVE);
for (const file of tracked) {
  let content;
  try {
    content = fs.readFileSync(path.join(ROOT, file), 'utf-8');
  } catch {
    continue; // binary or unreadable — git grep in the history pass still covers it
  }
  scanContent(file, content);
}

// ---- 2. Full history (a version tag publishes every commit) ----
// `git grep -I` skips binary files; pathspec excludes the scanner itself.
const combined = PATTERNS.map((p) => `(${p.re.source})`).join('|');
const commits = git('rev-list HEAD').split('\n').filter(Boolean);
for (const commit of commits) {
  let out;
  try {
    out = git(`grep -I -n -E "${combined}" ${commit} -- . ":(exclude)${SELF_RELATIVE}"`);
  } catch {
    continue; // no match in this commit
  }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // format: <hash>:<path>:<line>:<content>
    const m = /^(?:[^:]+):(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const relFile = m[1];
    const lineNo = m[2];
    const text = m[3];
    for (const { name, re } of PATTERNS) {
      const hit = re.exec(text);
      if (hit) report(relFile, lineNo, name, hit[0]);
    }
  }
}

if (findings.length > 0) {
  console.error(`SECRET SCAN FAILED — ${findings.length} finding(s):\n`);
  for (const f of [...new Set(findings)]) console.error(f);
  console.error('\nRemove the secret, rotate it if it was ever pushed, or add a');
  console.error('short-fixture-safe pattern exclusion in scripts/scan-secrets.mjs.');
  process.exit(1);
}

console.log(`secret scan OK — ${tracked.length} tracked files, ${commits.length} commits scanned.`);
