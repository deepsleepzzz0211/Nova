import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createGrepTool } from '../../src/tools/grep.js';
import { runRipgrep } from '../../src/tools/ripgrep-worker.js';

// Integration coverage for the WASM ripgrep runner: a real engine pass over a
// real temp tree, plus the runner's two exit guarantees (timeout, cancel).
// Kept small on purpose — the pure mapping is unit-tested elsewhere.

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-rg-'));
  // ripgrep ≥13 documents .gitignore rules as git-repo-scoped (require-git);
  // make the fixture a repo so the ignore-behavior contract holds identically
  // on every platform (the CI split proved the no-.git case is platform-dependent).
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'alpha\nfind the cacheRetention knob\nomega\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'nothing here\ncacheRetention = short\n');
  fs.writeFileSync(path.join(root, 'src', 'skip.log'), 'cacheRetention in an ignored file\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n');
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({ workingDirectory: root, abortSignal: new AbortController().signal });

describe('grep tool on the real WASM engine', () => {
  it('files mode finds matches and honors .gitignore', async () => {
    const r = await createGrepTool().execute({ pattern: 'cacheRetention' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('src/a.ts');
    expect(r.content).toContain('src/b.ts');
    expect(r.content).not.toContain('skip.log');
  });

  it('content mode renders path:line:text with real line numbers', async () => {
    const r = await createGrepTool().execute({ pattern: 'knob', output_mode: 'content' }, ctx());
    expect(r.content).toContain('src/a.ts:2:');
    expect(r.content).toContain('knob');
  });

  it('count mode totals real matches', async () => {
    const r = await createGrepTool().execute({ pattern: 'cacheRetention', output_mode: 'count' }, ctx());
    expect(r.content).toContain('a.ts:1');
    expect(r.content).toContain('b.ts:1');
    expect(r.content).toContain('Found 2 total occurrences across 2 files');
  });

  it('invalid regex surfaces the engine parse error as a tool error', async () => {
    const r = await createGrepTool().execute({ pattern: '(unclosed' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content.toLowerCase()).toContain('parse error');
  });

  it('case-insensitive and glob filters compose', async () => {
    const r = await createGrepTool().execute(
      { pattern: 'CACHERETENTION', '-i': true, glob: '*.ts' },
      ctx(),
    );
    expect(r.content).toContain('Found 2 files');
  });
});

describe('runRipgrep exit guarantees', () => {
  it('rejects with a timeout message when the search exceeds its budget', async () => {
    await expect(
      runRipgrep(['-e', 'x', root], { signal: new AbortController().signal, timeoutMs: 1 }),
    ).rejects.toThrow(/timed out/i);
  });

  it('rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runRipgrep(['-e', 'x', root], { signal: ac.signal, timeoutMs: 30_000 }),
    ).rejects.toThrow(/cancel|abort/i);
  });

  it('returns exit code 1 (not a throw) for a no-match search', async () => {
    const res = await runRipgrep(['-l', '--null', '-e', 'zz-definitely-absent', '--', root], {
      signal: new AbortController().signal,
      timeoutMs: 30_000,
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
  });
});
