#!/usr/bin/env node
/**
 * Dependency audit gate incl. DEV deps + dated waivers (p1-p2 07,
 * report-15). Replaces `pnpm audit --prod --audit-level=high`: dev tools
 * (vitest/stryker/tsup/tui-test) execute code in CI and at publish time,
 * so their advisories are not second-class. A waiver must carry a reason
 * AND an expiry — expired waivers do not waive, so a red cross can never
 * become wallpaper.
 *
 *   node scripts/audit-deps.mjs [--waivers <path>]   (default .auditignore.json)
 *
 * Exit: 0 = clean or all waived (summary printed), 1 = blocked findings
 * or unreadable input (fail closed).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_WAIVERS = '.auditignore.json';
const BLOCKING = new Set(['high', 'critical']);

/**
 * Normalize a `pnpm audit --json` report to {id, module, severity} findings,
 * keeping only blocking severities. Unknown shapes THROW (fail closed — an
 * audit that silently reads nothing is worse than no audit).
 * @param {any} report
 */
export function extractHighFindings(report) {
  if (!report || typeof report !== 'object' || report.advisories === undefined) {
    throw new Error('unrecognized audit report shape (expected { advisories }) — failing closed');
  }
  const out = [];
  for (const [key, adv] of Object.entries(report.advisories)) {
    const severity = adv?.severity ?? '';
    if (!BLOCKING.has(severity)) continue;
    out.push({
      id: adv.github_advisory_id ?? adv.githubAdvisoryId ?? key,
      module: adv.module_name ?? adv.moduleName ?? '?',
      severity,
    });
  }
  return out;
}

/**
 * @param {{ findings: {id: string, module: string, severity: string}[],
 *   waivers: {id: string, reason?: string, expires: string}[],
 *   today: string }} input
 * @returns {{ blocked: typeof input.findings, waived: (typeof input.findings & { waiver: unknown })[] }}
 */
export function evaluateAudit({ findings, waivers, today }) {
  // A waiver counts only with BOTH a future expiry and a written reason —
  // "evaluated" must mean someone recorded what they evaluated (p1-p2 07
  // review: docs said "must carry a reason"; now the code does too).
  const active = new Map(
    waivers
      .filter((w) => typeof w.expires === 'string' && w.expires >= today
        && typeof w.reason === 'string' && w.reason.trim() !== '')
      .map((w) => [w.id, w]),
  );
  const blocked = [];
  /** @type {any[]} */
  const waived = [];
  for (const finding of findings) {
    const hit = active.get(finding.id);
    if (hit) waived.push({ ...finding, waiver: hit });
    else blocked.push(finding);
  }
  return { blocked, waived };
}

function main() {
  const waiverArg = process.argv.indexOf('--waivers');
  const waiverPath = path.resolve(
    process.cwd(),
    waiverArg === -1 ? DEFAULT_WAIVERS : process.argv[waiverArg + 1],
  );
  let waivers = [];
  if (fs.existsSync(waiverPath)) {
    const parsed = JSON.parse(fs.readFileSync(waiverPath, 'utf-8'));
    if (!Array.isArray(parsed?.waivers)) {
      console.error(`[AUDIT] ${path.basename(waiverPath)} must be { "waivers": [...] } — failing closed`);
      process.exit(1);
    }
    waivers = parsed.waivers;
  }

  const pnpmExe = 'pnpm';
  let raw;
  try {
    raw = execFileSync(pnpmExe, ['audit', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // pnpm audit exits non-zero when vulns exist but --json still lands on
    // stdout; anything else (no lockfile, network) must not pass silently.
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    if (!stdout.trim()) {
      console.error('[AUDIT] pnpm audit failed to run — failing closed:', error?.message ?? error);
      process.exit(1);
    }
    raw = stdout;
  }

  let findings;
  try {
    findings = extractHighFindings(JSON.parse(raw));
  } catch (error) {
    console.error(`[AUDIT] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const { blocked, waived } = evaluateAudit({
    findings,
    waivers,
    today: new Date().toISOString().slice(0, 10),
  });

  for (const w of waived) {
    console.log(`[AUDIT] waived ${w.id} (${w.module}) until ${w.waiver.expires} — ${w.waiver.reason ?? 'no reason given'}`);
  }
  if (blocked.length > 0) {
    console.error(`[AUDIT] FAILED — ${blocked.length} unwaived high/critical finding(s):`);
    for (const b of blocked) console.error(`  ${b.id} ${b.module} [${b.severity}]`);
    console.error(`Fix the dependency, or add a dated waiver with a reason to ${DEFAULT_WAIVERS}.`);
    process.exit(1);
  }
  console.log(`[AUDIT] OK — ${findings.length} high/critical finding(s), ${waived.length} waived (dev deps included)`);
}

if (process.argv[1] && process.argv[1].split(/[\\/]/).join('/').endsWith('scripts/audit-deps.mjs')) {
  main();
}
