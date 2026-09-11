#!/usr/bin/env node
/**
 * Fail fast when a required environment variable is missing.
 *
 * Used by `pnpm test:e2e:llm`: the real-LLM suite is a deliberate local
 * action, so a missing key must be an error with instructions rather than a
 * silent skip (ticket e2e-testing 05).
 */
const names = process.argv.slice(2);
const missing = names.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.length === 0;
});

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('');
  console.error('The real-LLM E2E suite is local-only (CI never has a key). Set one, e.g.:');
  console.error(`  PowerShell:  $env:${missing[0]} = "<your key>"`);
  console.error(`  bash/zsh:    export ${missing[0]}=<your key>`);
  console.error('');
  console.error('Details: tests/e2e/README.md');
  process.exit(1);
}
