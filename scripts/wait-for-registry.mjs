#!/usr/bin/env node
/**
 * Wait for a published version to become visible on the registry
 * (p1-p2 06, report-14) — exponential backoff 1s→2s→4s→8s→16s(clamped),
 * total budget 5 minutes. Most releases are visible within seconds; the old
 * fixed 15 s cadence just wasted the common case, while the generous
 * ceiling (beta.2 lesson) keeps slow propagation from red-failing a job
 * whose publish actually succeeded.
 *
 *   node scripts/wait-for-registry.mjs <version>
 *
 * Exit: 0 visible, 1 not visible within budget. waitForRegistry is exported
 * pure (probe/sleep/clock injectable) and unit-tested.
 */
import { execFileSync } from 'node:child_process';

const PACKAGE = '@posuiqianqiu/nova';
const BASE_MS = 1_000;
const CLAMP_MS = 16_000;
const BUDGET_MS = 300_000;

/**
 * @param {{
 *   probe: () => Promise<boolean>,
 *   sleep: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   budgetMs?: number,
 *   startMs?: number,
 * }} opts
 */
export async function waitForRegistry(opts) {
  const { probe, sleep } = opts;
  const now = opts.now ?? (() => Date.now());
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const start = now();
  let attempts = 0;
  let delay = BASE_MS;
  for (;;) {
    attempts += 1;
    let visible = false;
    try {
      visible = await probe();
    } catch {
      visible = false; // a failed probe is "not yet", never fatal
    }
    if (visible) return { visible: true, attempts };
    if (now() - start >= budgetMs) return { visible: false, attempts };
    await sleep(delay);
    delay = Math.min(delay * 2, CLAMP_MS);
  }
}

function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`usage: node scripts/wait-for-registry.mjs <version> (got: ${version ?? 'none'})`);
    process.exit(1);
  }
  const npmExe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  waitForRegistry({
    probe: async () => {
      try {
        execFileSync(npmExe, ['view', `${PACKAGE}@${version}`, 'version'], {
          stdio: ['ignore', 'ignore', 'ignore'],
          shell: process.platform === 'win32',
        });
        return true;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then((res) => {
    if (res.visible) {
      console.log(`registry visible: ${PACKAGE}@${version} after ${res.attempts} probe(s)`);
      return;
    }
    console.error(`version ${version} still not visible after the 5-minute budget (${res.attempts} probes)`);
    process.exit(1);
  });
}

if (process.argv[1] && process.argv[1].split(/[\\/]/).join('/').endsWith('scripts/wait-for-registry.mjs')) {
  main();
}
