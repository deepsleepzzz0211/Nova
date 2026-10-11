import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * E2E (memory-v2 ticket 03): on-demand recall. A detail lives ONLY in a topic
 * file body; the MEMORY.md index line is deliberately vague. A fresh CLI
 * session must follow the injected recall protocol — grep the memory tree,
 * read_file the hit — and answer with the body-only detail. Assertions are
 * STRUCTURAL (protocol tools ran, the answer carries the token, exit 0),
 * never model wording. Same harness rules as print-mode.test.ts: built
 * binary, isolated NOVA_HOME, key-gated with rate-limit retry + skip.
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
      env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
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

async function runOrSkip(args: string[], cwd: string, skip: (note?: string) => void): Promise<RunResult | null> {
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

/** Workspace whose (only) memory is one topic file with a vague index hook. */
function makeMemoryWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-mem-'));
  const novaDir = path.join(cwd, '.nova');
  const memDir = path.join(novaDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
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
  fs.writeFileSync(
    path.join(memDir, 'legacy-host.md'),
    [
      '---',
      'name: legacy-host',
      'description: 一条老环境细节，正文才有具体值',
      'metadata:',
      '  type: project',
      '---',
      '',
      'The legacy deploy target hostname is atlas-edge-7; keep its SSH alias until the 2027 migration.',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(memDir, 'MEMORY.md'),
    '- [legacy-host](legacy-host.md) — an old environment quirk, details only in the file\n',
    'utf-8',
  );
  return cwd;
}

beforeAll(() => {
  if (!fs.existsSync(BINARY)) {
    throw new Error('dist/index.js missing — run `pnpm build` before `pnpm test:e2e`');
  }
});

describe('memory recall protocol end-to-end (real LLM)', () => {
  it.skipIf(!apiKey)('greps the memory tree and reads the topic file to answer a body-only detail', async ({ skip }) => {
    const cwd = makeMemoryWorkspace();
    try {
      const result = await runOrSkip(
        [
          '-p',
          '你记得 legacy 部署目标机器的 hostname 吗？按系统提示 Memory 段的召回协议执行：' +
            '先用 grep 工具在 Memory 段给出的记忆目录中搜索关键词（如 hostname / legacy），' +
            '再用 read_file 打开命中的主题文件，最后仅根据文件内容回答 hostname。' +
            '若搜索不到就回答 NONE，不要猜。',
          '--model',
          MODEL_SPEC,
          '--yes',
        ],
        cwd,
        skip,
      );
      if (result === null) return;
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('[Error:');
      expect(result.stdout).toContain('atlas-edge-7');
      // Structural: the transcript shows the protocol was followed — both
      // recall tools were invoked in this session.
      const sessionsDir = path.join(cwd, '.nova', 'sessions');
      const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
      expect(files.length).toBeGreaterThan(0);
      const raw = files.map((f) => fs.readFileSync(path.join(sessionsDir, f), 'utf-8')).join('\n');
      expect(raw).toContain('"grep"');
      expect(raw).toContain('"read_file"');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
