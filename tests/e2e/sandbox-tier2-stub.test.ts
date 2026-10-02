import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tier-2 POSIX stub contract (batch-B ticket 02): with sandbox
 * `os_level = "auto"` on a non-win32 leg, nova must print the fixed
 * landlock-not-wired notice to stderr once and keep running tier 1.
 * The win32 leg is covered by the local live demo (granting real ACLs is
 * out of scope for a shared CI runner).
 */

const BINARY = path.resolve('dist', 'index.js');
const POSIX_NOTICE = /OS-level sandbox: landlock .* not implemented .* — running tier-1 workspace path policy/i;

function runNova(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      cwd,
      env: { ...process.env, NOVA_HOME: cwd },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('nova timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('sandbox os_level=auto on POSIX (ubuntu CI leg)', () => {
  it('prints the fixed landlock stub once and still starts the session', async () => {
    if (process.platform === 'win32') return; // win32 covered by live demo
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-tier2-'));
    fs.mkdirSync(path.join(cwd, '.nova'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.nova', 'models.json'),
      JSON.stringify({
        providers: {
          mock: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'x',
            models: [{ id: 'T', name: 'T', contextWindow: 10_000, maxTokens: 100 }],
          },
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(cwd, 'config.toml'),
      '[llm]\nprovider = "mock"\nmodel = "T"\napi_key = "x"\n\n[sandbox]\nos_level = "auto"\n',
      'utf-8',
    );
    // Unreachable endpoint: the run fails, but the notice must already have
    // fired during tool-runtime assembly — and the shell stayed startable.
    const run = await runNova(['--yes', '-p', 'hi'], cwd);
    const matches = (run.stderr.match(/OS-level sandbox:/g) ?? []).length;
    expect(matches, run.stderr).toBe(1);
    expect(run.stderr).toMatch(POSIX_NOTICE);
    expect(run.stderr).toMatch(/tier-1/i);
  });
});
