import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SCANNER = path.resolve('scripts/scan-secrets.mjs');

let repo: string;

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8' });
}

function commitFile(name: string, content: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  git(`add ${name}`);
  git(`-c user.email=t@t -c user.name=t commit -q -m "add ${name}"`);
}

function runScanner(): { status: number; output: string } {
  try {
    const out = execSync(`node ${SCANNER}`, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output: out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-secretscan-'));
  git('init -q');
  git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('scan-secrets (pre-publish secret gate)', () => {
  it('passes a clean repo (test fixtures with short fake keys are not flagged)', async () => {
    commitFile('a.ts', "const key = 'sk-abc123';\nconst t = 'tvly-test';\nconst x = 'sk-test';\n");
    const r = runScanner();
    expect(r.status).toBe(0);
  });

  it('flags OpenAI/OpenCode-style keys in the working tree', async () => {
    const fake = `sk-${'A1b2C3d4E5f6G7h8I9j0K1l2'}000`;
    commitFile('leak.ts', `const key = '${fake}';\n`);
    const r = runScanner();
    expect(r.status).toBe(1);
    expect(r.output).toContain('leak.ts');
    expect(r.output).toContain('OpenAI/OpenCode-style');
  });

  it('flags Tavily keys', async () => {
    commitFile('leak.ts', `const k = 'tvly-${'Ab3dEf6hIj9lMn5oQr8tUu10'}x';\n`);
    const r = runScanner();
    expect(r.status).toBe(1);
    expect(r.output).toContain('Tavily');
  });

  it('flags GitHub PATs and npm tokens', async () => {
    commitFile('leak.md', [
      `pat = github_pat_${'A1b2C3d4E5'}f6G7h8I9j0K1l2M3n4O5p6Q7r8`,
      `tok = ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5'}x`,
      `npm = npm_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p'}x`,
    ].join('\n'));
    const r = runScanner();
    expect(r.status).toBe(1);
    expect(r.output).toContain('GitHub');
    expect(r.output).toContain('npm token');
  });

  it('finds secrets buried in git history even after the file was removed', async () => {
    const fake = `sk-${'Z9y8X7w6V5u4T3s2R1q0P9o8'}xyz`;
    commitFile('oops.txt', `key = '${fake}'\n`);
    fs.rmSync(path.join(repo, 'oops.txt'));
    git('add -A');
    git('-c user.email=t@t -c user.name=t commit -q -m "remove oops"');
    // Working tree is clean now; history still holds the secret
    const r = runScanner();
    expect(r.status).toBe(1);
    // Found via the history pass even though the working tree is clean
    expect(r.output).toContain('oops.txt');
    expect(r.output).toContain('redacted');
  });

  it('never flags its own pattern definitions (self-exclusion)', async () => {
    // The scanner file itself contains regex literals like /npm_[A-Za-z0-9]{20,}/
    // which must not trip the scan when the script is part of the repo.
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCANNER, path.join(repo, 'scripts', 'scan-secrets.mjs'));
    git('add -A');
    git('-c user.email=t@t -c user.name=t commit -q -m "add scanner"');
    const r = runScanner();
    expect(r.status).toBe(0);
  });
});
