import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PiaiEngine } from '../../src/llm/piai-engine.js';
import { loadModelCatalogWithEngine, resolveModel } from '../../src/llm/catalog.js';
import { PiProvider } from '../../src/llm/providers/piai.js';
import type { Message } from '../../src/llm/types.js';

// Ticket 01 (responses-route): the wire protocol must follow the Nova
// catalog's resolution (BUILTIN table / models.json `api`), not the pi-ai
// factory's single bound adapter. Fake gateway asserts the endpoint path.

function readFixture(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'tests/e2e/fixtures/recorded', name),
    'utf-8',
  );
}

async function startGateway(scripts: string[]): Promise<{ url: string; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = scripts[Math.min(n, scripts.length - 1)] ?? '';
      n++;
      res.end(body.replace(/\r\n/g, '\n'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    paths,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

async function driveTurn(providerUrl: string, engineArg: () => { engine: PiaiEngine; provider: string; model: string }): Promise<void> {
  const { engine, provider: providerName, model } = engineArg();
  const { catalog } = loadModelCatalogWithEngine(engine, []);
  const resolved = resolveModel({ provider: providerName, model }, catalog);
  const provider = new PiProvider({
    engine,
    provider: resolved.name,
    model: resolved.model.id,
    baseUrl: providerUrl,
    apiKey: 'test-key',
  });
  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  for await (const _chunk of provider.chat(messages, { model })) { /* drain */ }
}

describe('wire protocol follows the Nova catalog (ticket 01)', () => {
  it('openai provider + unknown model id posts to /chat/completions, not /responses', async () => {
    const gw = await startGateway([readFixture('weixin-text.sse')]);
    try {
      await driveTurn(gw.url, () => ({ engine: new PiaiEngine(), provider: 'openai', model: 'Deepseek-v4-flash' }));
      expect(gw.paths.length).toBeGreaterThan(0);
      expect(gw.paths[0]).toBe('/v1/chat/completions');
      expect(gw.paths.some((p) => p.includes('/responses'))).toBe(false);
    } finally {
      await gw.close();
    }
  });

  it('known built-in model gpt-4o with baseUrl override also routes chat/completions', async () => {
    const gw = await startGateway([readFixture('weixin-text.sse')]);
    try {
      await driveTurn(gw.url, () => ({ engine: new PiaiEngine(), provider: 'openai', model: 'gpt-4o' }));
      expect(gw.paths[0]).toBe('/v1/chat/completions');
    } finally {
      await gw.close();
    }
  });

  it('models.json api declaration on a built-in provider is enforced on the wire', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-proto-'));
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({
      providers: { openai: { api: 'openai-completions', models: [{ id: 'custom-x' }] } },
    }));
    const gw = await startGateway([readFixture('weixin-text.sse')]);
    try {
      const engine = new PiaiEngine();
      const { catalog } = loadModelCatalogWithEngine(engine, [file]);
      const resolved = resolveModel({ provider: 'openai', model: 'custom-x' }, catalog);
      const provider = new PiProvider({
        engine,
        provider: resolved.name,
        model: resolved.model.id,
        baseUrl: gw.url,
        apiKey: 'test-key',
      });
      for await (const _c of provider.chat([{ role: 'user', content: 'hi' }], { model: 'custom-x' })) { /* drain */ }
      expect(gw.paths[0]).toBe('/v1/chat/completions');
    } finally {
      await gw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blank config defaults never mask models.json baseUrl/apiKey declarations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mask-'));
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({
      providers: { proto2: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'declared-key', models: [{ id: 'm' }] } },
    }));
    try {
      const { catalog } = loadModelCatalogWithEngine(new PiaiEngine(), [file]);
      // Exactly what loadConfig hands over with no user overrides today:
      // empty strings from DEFAULT_CONFIG.
      const r = resolveModel({ provider: 'proto2', model: 'm', baseUrl: '', apiKey: '' }, catalog);
      expect(r.baseUrl).toBe('http://127.0.0.1:9/v1');
      expect(r.apiKey).toBe('declared-key');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assistant text mixed with tool_calls round-trips to a second request without wire rejection', async () => {
    const gw = await startGateway([readFixture('weixin-text.sse'), readFixture('weixin-text.sse')]);
    try {
      const engine = new PiaiEngine();
      const { catalog } = loadModelCatalogWithEngine(engine, []);
      const resolved = resolveModel({ provider: 'openai', model: 'mystery-model' }, catalog);
      const provider = new PiProvider({
        engine,
        provider: resolved.name,
        model: resolved.model.id,
        baseUrl: gw.url,
        apiKey: 'test-key',
      });
      // Historical repro: round 2 replays an assistant carrying BOTH text
      // content and a tool_calls batch, followed by the tool result. The
      // template bug sent that as Responses parts (output_text) -> 400.
      const history: Message[] = [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: 'I will read it.',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'probe content' },
      ];
      for await (const _c of provider.chat(history, { model: 'mystery-model' })) { /* drain */ }
      expect(gw.paths.length).toBeGreaterThan(0);
      expect(gw.paths.every((p) => p === '/v1/chat/completions')).toBe(true);
    } finally {
      await gw.close();
    }
  });
});
