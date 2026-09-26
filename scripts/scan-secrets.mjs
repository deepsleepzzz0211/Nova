#!/usr/bin/env node
/**
 * Pre-publish secret scanner (release gate).
 *
 * Scans what a version tag actually publishes:
 *   1. the HEAD working tree (all tracked files)
 *   2. the ENTIRE git history (a tag carries every commit)
 *
 * Detection is by well-known token prefixes (npm/GitHub/OpenAI/Tavily/AWS/
 * Slack/Stripe/GCP-service-account/PEM) with minimum lengths chosen so that
 * test fixtures (sk-test / tvly-x / tvly-test / sk-abc123) never match.
 * The scanner excludes its own file (its regex sources contain token-prefix
 * literals by definition); further legitimate exceptions go in
 * .secretsignore (one exact tracked path per line), not in this source file.
 *
 * History scan is SINGLE-PROCESS: `git grep -E <pattern> <revs...>` takes
 * many revisions per invocation (chunked to stay under the OS argv limit),
 * replacing the old per-commit spawn loop whose 178 process launches
 * dominated runtime (audit-fixes 04; ~17x faster on Windows).
 *
 * Exit codes: 0 = clean, 1 = secret-like material found (or git error).
 * Usage: node scripts/scan-secrets.mjs [repoRoot]   (default: cwd)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? '.');
const SELF_RELATIVE = 'scripts/scan-secrets.mjs';

/**
 * Re-allowlist (p1-p2 08): repo-root `.secretsignore`, one exact tracked path per
 * line (`#` comments allowed). Replaces the hardcoded single-path fixture
 * exemption from audit-fixes 04 — legitimate exceptions (the scanner
 * contract test's planted fakes, illustrative key blocks in docs) are data,
 * not a source edit. Path-only by design: content-based waivers rot into
 * places real secrets can hide. Absent file = no extra exclusions.
 */
const SECRETS_IGNORE = '.secretsignore';

/** Revisions per `git grep` invocation; keeps argv well under OS limits. */
const REV_BATCH = 400;

const PATTERNS = [
  { name: 'OpenAI/OpenCode-style key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Tavily key', re: /tvly-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub classic token', re: /gh[posur]_[A-Za-z0-9]{20,}/ },
  { name: 'npm token', re: /npm_[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: 'Stripe secret key', re: /sk_(live|test)_[0-9a-zA-Z]{20,}/ },
  // ` *` not `\s*`: the history pass runs POSIX ERE (git grep), which has
  // no \s — this form is valid in both engines.
  { name: 'GCP service-account key JSON', re: /"private_key_id": *"/ },
  { name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function loadExclusions() {
  const file = path.join(ROOT, SECRETS_IGNORE);
  const base = [SELF_RELATIVE];
  if (!fs.existsSync(file)) return base;
  const lines = fs.readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return [...new Set([...base, ...lines])];
}

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
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** git grep exit code 1 means "no matches"; anything else is a real error. */
function gitGrepOrEmpty(args) {
  try {
    return git(args);
  } catch (error) {
    if (error?.status === 1) return '';
    throw error;
  }
}

function main() {
  const startedAt = Date.now();
  const exclusions = loadExclusions();

  // ---- 1. HEAD working tree (tracked files only) ----
  const tracked = git(['ls-files']).split('\n')
    .filter((f) => f && !exclusions.includes(f));
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
  // `git grep -I` skips binary files; pathspecs carry the exclusions.
  const combined = PATTERNS.map((p) => `(${p.re.source})`).join('|');
  const commits = git(['rev-list', 'HEAD']).split('\n').filter(Boolean);
  for (let i = 0; i < commits.length; i += REV_BATCH) {
    const batch = commits.slice(i, i + REV_BATCH);
    const out = gitGrepOrEmpty([
      'grep', '-I', '-n', '-E', combined, ...batch,
      '--', '.', ...exclusions.map((p) => `:(exclude)${p}`),
    ]);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      // format: <hash>:<path>:<line>:<content>
      const m = /^(?:[^:]+):(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const [, relFile, lineNo, text] = m;
      for (const { name, re } of PATTERNS) {
        const hit = re.exec(text);
        if (hit) report(relFile, lineNo, name, hit[0]);
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (findings.length > 0) {
    console.error(`SECRET SCAN FAILED — ${findings.length} finding(s):\n`);
    for (const f of [...new Set(findings)]) console.error(f);
    console.error('\nRemove the secret, rotate it if it was ever pushed, or add a');
    console.error('short-fixture-safe pattern exclusion in scripts/scan-secrets.mjs.');
    process.exit(1);
  }

  console.log(
    `secret scan OK — ${tracked.length} tracked files, ${commits.length} commits`
    + ` scanned in ${elapsedMs} ms (${Math.ceil(commits.length / REV_BATCH)} git grep call(s)).`,
  );
}

try {
  main();
} catch (error) {
  console.error(`SECRET SCAN ERROR — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
