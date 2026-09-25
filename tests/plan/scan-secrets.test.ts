import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// audit-fixes 04: secret-scanner behaviour contract. The scanner runs as a
// subprocess over a throwaway git repo — history detection is the whole
// point of the tool, so it must survive the single-process rewrite.
// All tokens here are obviously-fake fixtures (pattern-matching only).

const SCANNER = fileURLToPath(new URL('../../scripts/scan-secrets.mjs', import.meta.url));
const FAKE_SK = 'sk-FAKEFAKEFAKE0000000011112222';
const FAKE_TAVILY = 'tvly-FAKEFAKEFAKEFAKEFAKE00001';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.email=test@example.invalid',
    '-c', 'user.name=test', ...args], { cwd: repo, encoding: 'utf-8' });
}

function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-scan-'));
  git(repo, 'init', '-b', 'main');
  return repo;
}

function writeAndCommit(repo: string, file: string, content: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', `add ${file}`);
}

function runScanner(repo: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCANNER, repo], { encoding: 'utf-8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scan-secrets.mjs (audit-fixes 04)', () => {
  let repo: string;
  beforeEach(() => {
    repo = seedRepo();
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes a clean repo', () => {
    writeAndCommit(repo, 'README.md', '# project\nnothing to see\n');
    const run = runScanner(repo);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('secret scan OK');
  });

  it('flags a secret living in the HEAD tree', () => {
    writeAndCommit(repo, 'README.md', '# clean\n');
    writeAndCommit(repo, 'config.leak', `apiKey = "${FAKE_SK}"\n`);
    const run = runScanner(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(FAKE_SK.slice(0, 6));
    expect(run.stderr).toMatch(/config\.leak/);
  });

  it('flags a secret that was deleted from the tree but lives in history', () => {
    writeAndCommit(repo, 'README.md', '# clean\n');
    writeAndCommit(repo, 'src/leaky.ts', `const key = "${FAKE_TAVILY}";\n`);
    git(repo, 'rm', '-q', 'src/leaky.ts');
    git(repo, 'commit', '-m', 'remove leaky file');
    const run = runScanner(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Tavily key');
    expect(run.stderr).toContain(FAKE_TAVILY.slice(0, 6));
  });

  it('never matches the short test fixtures documented in the header', () => {
    writeAndCommit(repo, 'tests/fixtures.ts', [
      'sk-test', 'tvly-x', 'tvly-test', 'sk-abc123', 'gh-notatoken',
    ].join('\n') + '\n');
    const run = runScanner(repo);
    expect(run.status).toBe(0);
  });

  it('exits 1 with a readable error (not a raw stack) outside a git repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-nogit-'));
    try {
      fs.writeFileSync(path.join(plain, 'file.txt'), 'hello\n');
      const run = runScanner(plain);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('SECRET SCAN ERROR');
      expect(run.stderr).not.toContain('at ');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
