import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * JSONL stream contract E2E (batch-B ticket 08): the built CLI runs against
 * a LOCAL SSE mock replaying the recorded gateway fixtures — deterministic,
 * key-free, CI-safe. Locks: the v1 event family and ordering under
 * `--output-format jsonl`, byte-identical text-mode output (the pre-existing
 * contract), and the jsonl exit-code truth (sawError really exits non-zero
 * there; text mode keeps its historical 0).
 */

const BINARY = path.resolve('dist', 'index.js');
const FIXTURES = path.resolve('tests/e2e/fixtures/recorded');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNova(args: string[], cwd: string, timeoutMs = 90_000): Promise<RunResult> {
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

function sseBody(chunks: Record<string, unknown>[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function fixtureChunks(name: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf-8')
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l.slice(6) !== '[DONE]')
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

function failureChunks(): Record<string, unknown>[] {
  const mk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id: 'fail-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'TEST',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish, matched_stop: null }],
  });
  return [mk({ role: 'assistant', content: '[Error: forced provider failure]' }, null), mk({}, 'stop')];
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => { body += d.toString(); });
    req.on('end', () => {
      const url = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.startsWith('/failure/')) {
        res.end(sseBody(failureChunks()));
        return;
      }

      // First call asks for a tool; the follow-up (which carries the tool
      // result message) answers with the recorded text stream.
      const hasToolResult = /"role":\s*"tool"/.test(body);
      res.end(sseBody(fixtureChunks(hasToolResult ? 'weixin-text.sse' : 'weixin-toolcall.sse')));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server?.close();
});

function makeWorkspace(mode: 'flow' | 'failure'): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-jsonl-e2e-'));
  const novaDir = path.join(cwd, '.nova');
  fs.mkdirSync(novaDir, { recursive: true });
  fs.writeFileSync(
    path.join(novaDir, 'models.json'),
    JSON.stringify({
      providers: {
        mock: {
          api: 'openai-completions',
          baseUrl: `${baseUrl}/${mode}/v1`,
          apiKey: 'mock-key',
          models: [
            {
              id: 'TEST',
              name: 'TEST',
              contextWindow: 100_000,
              maxTokens: 1000,
              compat: { supportsDeveloperRole: false, streamUsage: true },
            },
          ],
        },
      },
    }),
    'utf-8',
  );
  return cwd;
}

type Evt = Record<string, unknown>;
const evsOf = (stdout: string): Evt[] =>
  stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Evt);

describe('nova -p --output-format jsonl (built CLI, local SSE mock)', () => {
  it('emits the v1 event family in order, with tool_call and tool_result', async () => {
    const cwd = makeWorkspace('flow');
    const run = await runNova(['--model', 'mock/TEST', '--yes', '-p', 'read the file', '--output-format', 'jsonl'], cwd);
    expect(run.code, run.stderr.slice(0, 300)).toBe(0);
    const evs = evsOf(run.stdout);
    expect(evs[0]).toMatchObject({ v: 1, ev: 'start', model: 'TEST' });
    expect(typeof evs[0]?.session_id).toBe('string');
    const names = evs.map((e) => e.ev);
    expect(names).toContain('tool_call');
    expect(names).toContain('tool_result');
    expect(names).toContain('text');
    expect(names).toContain('usage');
    expect(names[names.length - 1]).toBe('result');
    const toolCall = evs.find((e) => e.ev === 'tool_call')!;
    expect(toolCall).toMatchObject({ name: 'run_bash', v: 1 });
    expect(typeof toolCall.arguments).toBe('string');
    const toolResult = evs.find((e) => e.ev === 'tool_result')!;
    expect(toolResult.is_error).toBe(true); // run_bash is not registered
    const result = evs[evs.length - 1]!;
    expect(result).toMatchObject({ ev: 'result', text: 'RECORDED-TEXT-OK', exit_code: 0 });
    for (const line of run.stdout.split('\n').filter((l) => l.trim() !== '')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(65_536);
    }
  });

  it('text mode output stays byte-identical to the historical contract', async () => {
    const cwd = makeWorkspace('flow');
    const run = await runNova(['--model', 'mock/TEST', '--yes', '-p', 'read the file'], cwd);
    expect(run.code, run.stderr.slice(0, 300)).toBe(0);
    // The recorded tool-call fixture streams two newline text tokens before
    // the call; locking the exact bytes also locks that the jsonl refactor
    // left the text path untouched.
    expect(run.stdout).toBe('\n\nRECORDED-TEXT-OK\n');
  });

  it('jsonl exits non-zero when the turn saw an [Error: token; text mode keeps exit 0', async () => {
    const cwd = makeWorkspace('failure');
    const jsonl = await runNova(
      ['--model', 'mock/TEST', '--yes', '-p', 'fail', '--output-format', 'jsonl'],
      cwd,
    );
    expect(jsonl.code).toBe(1);
    const evs = evsOf(jsonl.stdout);
    const result = evs[evs.length - 1]!;
    expect(result.ev).toBe('result');
    expect(result.exit_code).toBe(1);
    expect(String(result.text)).toContain('[Error: forced provider failure]');

    const textRun = await runNova(['--model', 'mock/TEST', '--yes', '-p', 'fail'], cwd);
    expect(textRun.code).toBe(0);
    expect(textRun.stdout).toBe('[Error: forced provider failure]\n');
  });
});
