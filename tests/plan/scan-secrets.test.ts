import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

// audit-fixes 04: secret-scanner behaviour contract. The scanner runs as a
// subprocess over a throwaway git repo — history detection is the whole
// point of the tool, so it must survive the single-process rewrite.
//
// The fake tokens below NEVER appear as contiguous literals: this file is
// itself scanned by the tool it tests (and by GitHub push protection), and
// lesson 31 says anything committed here stays in history. The scanner
// carries one documented path exclusion for this file to cover the earlier
// literal-token commits; the concatenation keeps NEW commits clean anyway.

const fake = (prefix: string, body: string): string => `${prefix}${body}`;
const FAKE = {
  openai: fake('sk-', 'FAKEFAKEFAKE0000000011112222'),
  tavily: fake('tvly-', 'FAKEFAKEFAKEFAKEFAKE00001'),
  ghPat: fake('github_pat_', 'FAKEFAKEFAKE000000001111222233334444'),
  ghClassic: fake('ghp_', 'FAKEFAKEFAKEFAKE0000000011112222'),
  npm: fake('npm_', 'FAKEFAKEFAKE0000111122223333'),
};

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

const SCANNER = fileURLToPath(new URL('../../scripts/scan-secrets.mjs', import.meta.url));

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
    writeAndCommit(repo, 'config.leak', `apiKey = "${FAKE.openai}"\n`);
    const run = runScanner(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('OpenAI/OpenCode-style key');
    expect(run.stderr).toMatch(/config\.leak/);
  });

  it('flags every token shape deleted from the tree but living in history', () => {
    writeAndCommit(repo, 'README.md', '# clean\n');
    const all = Object.values(FAKE).map((t) => `"${t}"`).join('\n');
    writeAndCommit(repo, 'src/leaky.ts', `const keys = [\n${all}\n];\n`);
    git(repo, 'rm', '-q', 'src/leaky.ts');
    git(repo, 'commit', '-m', 'remove leaky file');
    const run = runScanner(repo);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('OpenAI/OpenCode-style key');
    expect(run.stderr).toContain('Tavily key');
    expect(run.stderr).toContain('GitHub fine-grained PAT');
    expect(run.stderr).toContain('GitHub classic token');
    expect(run.stderr).toContain('npm token');
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
