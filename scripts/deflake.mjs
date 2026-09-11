#!/usr/bin/env node
/**
 * Deflake helper (ticket e2e-testing 06): run a vitest command N times and
 * report which tests are flaky (fail in some runs, pass in others) instead of
 * relying on memory.
 *
 * Usage:
 *   node scripts/deflake.mjs --runs=5 -- pnpm test:e2e:llm
 *   node scripts/deflake.mjs --runs=3 --command="pnpm test:e2e:deterministic"
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function parseArgs(argv) {
  let runs = 5;
  let command = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--runs=')) runs = Number.parseInt(arg.slice('--runs='.length), 10);
    else if (arg === '--runs') runs = Number.parseInt(argv[++i], 10);
    else if (arg.startsWith('--command=')) command = arg.slice('--command='.length);
    else if (arg === '--') rest.push(...argv.slice(i + 1));
    else rest.push(arg);
  }
  return { runs, command: command ?? rest.join(' ') };
}

const { runs, command } = parseArgs(process.argv.slice(2));
if (!command || Number.isNaN(runs) || runs < 1) {
  console.error('Usage: node scripts/deflake.mjs --runs=N -- <command>');
  process.exit(2);
}

console.log(`Deflake: ${runs} run(s) of: ${command}`);
const failures = new Map(); // test name -> failed run numbers
const passes = new Map();

for (let run = 1; run <= runs; run++) {
  const report = path.join(os.tmpdir(), `nova-deflake-${process.pid}-${run}.json`);
  const result = spawnSync(
    `${command} --reporter=json --outputFile=${report}`,
    { shell: true, stdio: 'inherit' },
  );
  process.stdout.write(`\n[run ${run}/${runs}] exit=${result.status ?? 'null'}\n`);

  if (!fs.existsSync(report)) {
    console.log(`[run ${run}/${runs}] no JSON report produced (command failed to start?)`);
    continue;
  }
  const json = JSON.parse(fs.readFileSync(report, 'utf-8'));
  const seen = new Set();
  for (const suite of json.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      const name = `${path.basename(suite.name)} > ${assertion.fullName ?? assertion.title}`;
      seen.add(name);
      if (assertion.status === 'failed') {
        failures.set(name, [...(failures.get(name) ?? []), run]);
      } else if (assertion.status === 'passed') {
        passes.set(name, [...(passes.get(name) ?? []), run]);
      }
    }
  }
  for (const name of seen) {
    if (!passes.has(name)) passes.set(name, []);
  }
  fs.rmSync(report, { force: true });
}

console.log('\n=== Deflake summary ===');
const flaky = [...failures.keys()].filter((name) => (passes.get(name)?.length ?? 0) > 0);
const broken = [...failures.keys()].filter((name) => (passes.get(name)?.length ?? 0) === 0);

for (const [label, names] of [['FLAKY (passed at least once)', flaky], ['FAILING every run', broken]]) {
  if (names.length === 0) continue;
  console.log(`\n${label}:`);
  for (const name of names) {
    console.log(`  ${name} — failed in run(s) ${failures.get(name).join(', ')}`);
  }
}
if (flaky.length === 0 && broken.length === 0) {
  console.log('No failures across all runs.');
}

// A flaky suite must be visible in CI: exit non-zero when anything failed.
process.exit(failures.size > 0 ? 1 : 0);
