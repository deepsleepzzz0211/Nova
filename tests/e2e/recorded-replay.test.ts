import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadModelCatalogWithEngine, resolveModel } from '../../src/llm/catalog.js';
import { PiaiEngine } from '../../src/llm/piai-engine.js';
import { PiProvider } from '../../src/llm/providers/piai.js';
import type { StreamChunk } from '../../src/llm/types.js';

/**
 * Recorded-contract replay (test-effectiveness 02): byte-for-byte replay of
 * REAL weixin SSE recordings through the actual parse chain (pi-ai wire
 * adapter + piai-bridge). If the gateway's contract and our parser ever
 * diverge, this is where it shows — no hand-written mock mediates.
 */

const FIXTURES = path.resolve('tests/e2e/fixtures/recorded');

function loadFixture(name: string): { raw: string; events: Record<string, unknown>[] } {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
  const events = raw
    .split('\n')
    .filter((l) => l.startsWith('data: ') && l.slice(6) !== '[DONE]')
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  return { raw, events };
}

function expectedText(events: Record<string, unknown>[]): string {
  let out = '';
  for (const e of events) {
    for (const c of e.choices as { delta?: { content?: string | null } }[]) {
      out += c.delta?.content ?? '';
    }
  }
  return out;
}

function expectedUsage(events: Record<string, unknown>[]): { prompt: number; completion: number } {
  const u = (events.find((e) => e.usage !== undefined && e.usage !== null) as {
    usage: { prompt_tokens: number; completion_tokens: number };
  }).usage;
  return { prompt: u.prompt_tokens, completion: u.completion_tokens };
}

async function replay(name: string): Promise<StreamChunk[]> {
  const { raw, events } = loadFixture(name);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Write event-by-event like a real stream, then finish.
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    for (const l of lines) res.write(l + '\n\n');
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-replay-'));
    const catalogFile = path.join(tmp, 'models.json');
    fs.writeFileSync(catalogFile, JSON.stringify({
      providers: {
        replay: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'replay-key',
          models: [{
            id: 'Deepseek-v4-flash', contextWindow: 200_000, maxTokens: 8_000, reasoning: true,
            compat: { supportsDeveloperRole: false, streamUsage: true },
          }],
        },
      },
    }));
    const { catalog, engine } = loadModelCatalogWithEngine(new PiaiEngine(), [catalogFile]);
    const res = resolveModel({ provider: 'replay', model: 'Deepseek-v4-flash' }, catalog);
    const provider = new PiProvider({
      engine, provider: res.name, model: res.model.id, baseUrl: res.baseUrl, apiKey: res.apiKey,
    });
    const chunks: StreamChunk[] = [];
    for await (const c of provider.chat([{ role: 'user', content: 'replayed' }], { model: res.model.id })) {
      chunks.push(c);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => (c as { content: string }).content)
      .join('');
    expect(text).toBe(expectedText(events));
    const usage = chunks.find((c) => c.type === 'usage') as
      | { type: 'usage'; inputTokens: number; outputTokens: number }
      | undefined;
    const want = expectedUsage(events);
    expect(usage?.inputTokens).toBe(want.prompt);
    expect(usage?.outputTokens).toBe(want.completion);
    return chunks;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('recorded SSE replay through the real parse chain (test-effectiveness 02)', () => {
  it('text recording: deltas and usage survive pi-ai + bridge intact', async () => {
    await replay('weixin-text.sse');
  });

  it('tool-call recording: split arguments reassemble to one call', async () => {
    const chunks = await replay('weixin-toolcall.sse');
    const starts = chunks.filter((c) => c.type === 'tool_call_start');
    expect(starts.length).toBe(1);
    const args = chunks
      .filter((c) => c.type === 'tool_call_delta')
      .map((c) => (c as { arguments: string }).arguments)
      .join('');
    expect(JSON.parse(args)).toHaveProperty('command');
  });
});
