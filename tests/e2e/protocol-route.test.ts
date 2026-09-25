import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';

/**
 * Ticket 01 (responses-route), CLI level: a chat-completions gateway behind
 * the built-in-style provider must round-trip the historical failure shape —
 * an assistant reply mixing text with a tool call, replayed on round 2.
 * Deterministic (local fake gateway, no keys) → runs in CI.
 */

const BINARY = path.join(process.cwd(), 'dist', 'index.js');
const MARKER = 'PROTO-ROUTE-7f31-OK';

function sse(...objs: unknown[]): string {
  return objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function chunk(delta: unknown, finish: string | null = null): unknown {
  return { id: 'loc1', object: 'chat.completion.chunk', created: 1, model: 'unit-l', choices: [{ index: 0, delta, finish_reason: finish }] };
}

interface Captured { paths: string[]; bodies: string[] }

async function startFakeGateway(toolFilePath: string, cap: Captured): Promise<{ url: string; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      cap.paths.push(req.url ?? '');
      cap.bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (hits++ === 0) {
        res.end(sse(
          chunk({ role: 'assistant', content: 'I will read it. ' }),
          chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: toolFilePath }) } }] }),
          chunk({}, 'tool_calls'),
        ));
      } else {
        res.end(sse(chunk({ role: 'assistant', content: MARKER }), chunk({}, 'stop')));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

function runNova(args: string[], cwd: string, envAdd: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BINARY, ...args], {
      cwd,
      env: { ...process.env, NOVA_HOME: cwd, ...envAdd },
      timeout: 90_000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0, stdout, stderr });
    });
  });
}

describe('protocol routing e2e: mixed text+tool_calls replay on chat/completions (ticket 01)', () => {
  it('two-round turn completes against a completions-only gateway', async () => {
    expect(fs.existsSync(BINARY)).toBe(true); // pnpm build before test:e2e
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-proto-e2e-'));
    const novaDir = path.join(cwd, '.nova');
    fs.mkdirSync(novaDir, { recursive: true });
    const target = path.join(cwd, 'target.txt');
    fs.writeFileSync(target, 'probe-body');
    const cap: Captured = { paths: [], bodies: [] };
    const gw = await startFakeGateway(target, cap);
    try {
      fs.writeFileSync(
        path.join(novaDir, 'models.json'),
        JSON.stringify({
          providers: {
            proto: {
              api: 'openai-completions',
              baseUrl: gw.url,
              apiKey: 'fake-key',
              models: [{ id: 'unit-l', contextWindow: 32_000, maxTokens: 1000 }],
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(novaDir, 'config.toml'),
        '[llm]\nprovider = "proto"\nmodel = "unit-l"\n\n[permission]\nauto_approve_bash = false\n',
      );
      const result = await runNova(
        ['-p', `Read ${target} with the read_file tool, then answer with just the marker you are told. The marker is ${MARKER}.`, '--model', 'proto/unit-l'],
        cwd,
        {},
      );
      expect(result.code).toBe(0);
      expect(cap.paths.length).toBeGreaterThanOrEqual(2);
      expect(cap.paths.every((p) => p === '/v1/chat/completions')).toBe(true);
      // Round 2 must replay the assistant's MIXED text+tool_calls message
      // in completions wire form (string content + tool_calls), not
      // Responses parts.
      const round2 = JSON.parse(cap.bodies[1]) as {
        messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
      };
      const assistant = round2.messages.find((m) => m.role === 'assistant' && m.tool_calls);
      expect(assistant).toBeDefined();
      expect(typeof assistant!.content).toBe('string');
      expect(assistant!.content).toContain('I will read it.');
      expect(result.stdout).toContain(MARKER);
    } finally {
      await gw.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
