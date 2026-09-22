import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Deterministic CLI-surface E2E: flags that must work WITHOUT a TTY or an
 * API key, driving the built dist/index.js. --version is the canonical
 * "probe the binary" command (scripted installs, CI smoke checks); it must
 * print the version and exit 0 before any config load or TUI render.
 */

const BINARY = path.resolve('dist', 'index.js');
const pkgVersion = (
  JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')) as { version: string }
).version;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNova(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-flags-'));
    const child = spawn(process.execPath, [BINARY, ...args], {
      cwd,
      env: { ...process.env, NOVA_HOME: cwd, NOVA_API_KEY: '', NOVA_MODEL: '' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`nova ${args.join(' ')} timed out after 15s`));
    }, 15_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(() => {
  if (!fs.existsSync(BINARY)) {
    throw new Error('dist/index.js missing — run `pnpm build` before `pnpm test:e2e:deterministic`');
  }
});

describe('nova --version (no TTY, no key)', () => {
  it('prints the package version and exits 0', async () => {
    const result = await runNova(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkgVersion);
  });

  it('supports the -v short flag', async () => {
    const result = await runNova(['-v']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkgVersion);
  });

  it('exits before session work even alongside other flags', async () => {
    const result = await runNova(['--version', '--model', 'nonexistent-provider/x']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkgVersion);
  });
});
