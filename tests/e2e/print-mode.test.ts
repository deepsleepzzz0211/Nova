import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * E2E: the built CLI (`nova -p`) against a real LLM endpoint.
 *
 * Design notes (see docs/research/2026-09-10-e2e-testing-options.md):
 * - runs the BUILT artifact, not the sources (gemini-cli does the same);
 * - assertions are STRUCTURAL invariants (a tool ran, a file exists, the
 *   session JSONL has a turn, the exit code) — never model wording, which
 *   would make the suite flaky;
 * - a missing key skips with a clear message; a rate-limited provider
 *   retries once and then skips (free tiers cannot sustain E2E).
 */

const KEY_ENV = 'WEIXIN_API_KEY';
const MODEL_SPEC = 'weixin/Deepseek-v4-flash';
const BINARY = path.resolve('dist', 'index.js');
const apiKey = process.env[KEY_ENV];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNova(args: string[], cwd: string, timeoutMs = 150_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      cwd,
      env: {
        ...process.env,
        // Isolate the E2E run from the developer's own session store etc.
        NOVA_HOME: cwd,
        [KEY_ENV]: apiKey ?? '',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`nova timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function isRateLimited(result: RunResult): boolean {
  return /rate limit|Too Many Requests|429/i.test(result.stdout + result.stderr);
}

/** Run with one retry for transient provider throttling, then report skips. */
async function runOrSkip(
  args: string[],
  cwd: string,
  skip: (note?: string) => void,
): Promise<RunResult | null> {
  let result = await runNova(args, cwd);
  if (isRateLimited(result)) {
    await new Promise((r) => setTimeout(r, 5_000));
    result = await runNova(args, cwd);
  }
  if (isRateLimited(result)) {
    skip(`provider rate limit reached — ${(result.stdout + result.stderr).trim().slice(0, 160)}`);
    return null;
  }
  return result;
}

/**
 * Self-contained workspace: the E2E run gets its own NOVA_HOME with a
 * catalog that points at the test endpoint, so it never depends on (or
 * mutates) the developer's ~/.nova configuration.
 */
function makeWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
  const novaDir = path.join(cwd, '.nova');
  fs.mkdirSync(novaDir, { recursive: true });
  fs.writeFileSync(
    path.join(novaDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          weixin: {
            api: 'openai-completions',
            baseUrl: 'https://chatapi.weixin.qq.com/openai/v1',
            apiKey: `$${KEY_ENV}`,
            models: [
              {
                id: 'Deepseek-v4-flash',
                name: 'DeepSeek V4 Flash (E2E)',
                reasoning: true,
                contextWindow: 200_000,
                maxTokens: 48_000,
                compat: { supportsDeveloperRole: false, streamUsage: true },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  return cwd;
}

beforeAll(() => {
  if (!fs.existsSync(BINARY)) {
    throw new Error('dist/index.js missing — run `pnpm build` before `pnpm test:e2e`');
  }
});

describe('nova -p end-to-end (real LLM)', () => {
  it.skipIf(!apiKey)('answers a plain prompt and exits 0', async ({ skip }) => {
    const cwd = makeWorkspace();
    try {
      const result = await runOrSkip(
        ['-p', 'Reply with exactly the word: PONG', '--model', MODEL_SPEC],
        cwd,
        skip,
      );
      if (result === null) return;
      expect(result.code).toBe(0);
      expect(result.stdout.toUpperCase()).toContain('PONG');
      expect(result.stdout).not.toContain('[Error:');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(!apiKey)('runs a tool call and creates the file it was asked for', async ({ skip }) => {
    const cwd = makeWorkspace();
    try {
      const result = await runOrSkip(
        [
          '-p',
          'Use the write_file tool to create a file named e2e-created.txt containing the text OK, then reply DONE.',
          '--model',
          MODEL_SPEC,
          '--yes',
        ],
        cwd,
        skip,
      );
      if (result === null) return;
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(cwd, 'e2e-created.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(cwd, 'e2e-created.txt'), 'utf-8')).toContain('OK');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(!apiKey)('persists the turn to the session JSONL', async ({ skip }) => {
    const cwd = makeWorkspace();
    try {
      const result = await runOrSkip(
        ['-p', 'Remember the number 41. Reply ACK.', '--model', MODEL_SPEC],
        cwd,
        skip,
      );
      if (result === null) return;
      expect(result.code).toBe(0);
      const sessionsDir = path.join(cwd, '.nova', 'sessions');
      const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
      expect(files.length).toBeGreaterThan(0);
      const lines = fs
        .readFileSync(path.join(sessionsDir, files[0]), 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { type?: string; role?: string });
      expect(lines.some((l) => l.role === 'user')).toBe(true);
      expect(lines.some((l) => l.role === 'assistant')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(!apiKey)('exits non-zero when the provider rejects the request', async () => {
    const cwd = makeWorkspace();
    try {
      // Unknown provider in the catalog -> resolution/authentication failure.
      const result = await runNova(['-p', 'hi', '--model', 'nonexistent-provider/some-model'], cwd, 60_000);
      expect(result.code).not.toBe(0);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
