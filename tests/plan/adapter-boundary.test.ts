/**
 * Adapter boundary tests (coverage ticket 03): anthropic-messages stream
 * normalization (SDK mocked) and ollama adapter request/parse boundaries.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';

// ---- anthropic: mock the SDK before the adapter import -------------------
const anthropicState = vi.hoisted(() => ({
  events: [] as unknown[],
  ctorArgs: [] as unknown[],
  params: [] as unknown[],
}));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeStream {
    async *[Symbol.asyncIterator]() {
      for (const e of anthropicState.events) yield e;
    }
  }
  class Anthropic {
    messages = {
      stream: (params: unknown) => {
        anthropicState.params.push(params);
        return new FakeStream();
      },
    };
    constructor(...args: unknown[]) {
      anthropicState.ctorArgs.push(args);
    }
  }
  return { default: Anthropic };
});

import { AnthropicMessagesAdapter } from '../../src/llm/adapters/anthropic-messages.js';
import { OllamaAdapter } from '../../src/llm/adapters/ollama.js';
import { OllamaProvider } from '../../src/llm/providers/ollama.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  anthropicState.events = [];
  anthropicState.params = [];
});

// ---- anthropic-messages ---------------------------------------------------

const baseMessages: Message[] = [
  { role: 'user', content: 'question' },
  { role: 'assistant', content: 'answer' },
];

function makeAdapter(opts?: { thinkingLevelMap?: unknown; reasoning?: boolean }): AnthropicMessagesAdapter {
  return new AnthropicMessagesAdapter({
    apiKey: 'k',
    baseUrl: 'https://api.example.com',
    thinkingLevelMap: opts?.thinkingLevelMap as never,
    reasoning: opts?.reasoning,
  } as never);
}

describe('AnthropicMessagesAdapter request construction (SDK mocked)', () => {
  it('first system message → system param with cache_control; later systems → [context] user messages', async () => {
    anthropicState.events = [{ type: 'message_stop' }];
    const adapter = makeAdapter();
    const messages: Message[] = [
      { role: 'system', content: 'the real system prompt' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'injected skill body' },
    ];
    await collect(adapter.chat(messages, { model: 'claude-x', systemPrompt: 'the real system prompt' }));
    const params = anthropicState.params[0] as Record<string, unknown>;
    expect(params.system).toEqual([
      { type: 'text', text: 'the real system prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.messages).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: '[context] injected skill body' },
    ]);
  });

  it('cache_control lands only on the LAST tool', async () => {
    anthropicState.events = [{ type: 'message_stop' }];
    const adapter = makeAdapter();
    const tools = [
      { name: 'tool_a', input_schema: {} },
      { name: 'tool_b', input_schema: {} },
      { name: 'tool_c', input_schema: {} },
    ];
    await collect(adapter.chat(baseMessages, { model: 'claude-x', tools: tools as never }));
    const sent = (anthropicState.params[0] as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(sent[0]).not.toHaveProperty('cache_control');
    expect(sent[1]).not.toHaveProperty('cache_control');
    expect(sent[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('raises max_tokens above the thinking budget when they collide', async () => {
    anthropicState.events = [{ type: 'message_stop' }];
    // The map only enables/disables the level; the budget comes from the
    // fixed table (high = 16384). maxTokens 4096 <= budget → raised to
    // budget + 4096.
    const adapter = makeAdapter({ thinkingLevelMap: { high: 16384 }, reasoning: true });
    await collect(adapter.chat(baseMessages, { model: 'claude-x', thinkingLevel: 'high', maxTokens: 4096 }));
    const params = anthropicState.params[0] as Record<string, unknown>;
    expect(params.max_tokens).toBe(16384 + 4096);
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('disables thinking when the map nulls the level', async () => {
    anthropicState.events = [{ type: 'message_stop' }];
    const adapter = makeAdapter({ thinkingLevelMap: { high: null }, reasoning: true });
    await collect(adapter.chat(baseMessages, { model: 'claude-x', thinkingLevel: 'high', maxTokens: 4096 }));
    const params = anthropicState.params[0] as Record<string, unknown>;
    expect(params.thinking).toBeUndefined();
    expect(params.max_tokens).toBe(4096);
  });

  it('passes maxTokens through unchanged when the budget does not collide', async () => {
    anthropicState.events = [{ type: 'message_stop' }];
    const adapter = makeAdapter({ reasoning: false });
    await collect(adapter.chat(baseMessages, { model: 'claude-x', maxTokens: 1234 }));
    const params = anthropicState.params[0] as Record<string, unknown>;
    expect(params.max_tokens).toBe(1234);
    expect(params.thinking).toBeUndefined();
  });

  it('forwards baseUrl and apiKey to the SDK client', () => {
    makeAdapter();
    const [ctor] = anthropicState.ctorArgs as Array<[{ apiKey: string; baseURL: string }]>;
    expect(ctor[0].apiKey).toBe('k');
    expect(ctor[0].baseURL).toBe('https://api.example.com');
  });
});

describe('AnthropicMessagesAdapter stream normalization (SDK mocked)', () => {
  it('normalizes the full event vocabulary', async () => {
    anthropicState.events = [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 20 } } },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'bash' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"c' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'ommand":"ls"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', usage: { output_tokens: 42 } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(makeAdapter().chat(baseMessages, { model: 'claude-x' }));

    expect(chunks).toEqual([
      { type: 'text_delta', content: 'hello' },
      { type: 'tool_call_start', id: 't1', name: 'bash' },
      { type: 'tool_call_delta', id: 't1', arguments: '{"c' },
      { type: 'tool_call_delta', id: 't1', arguments: 'ommand":"ls"}' },
      { type: 'tool_call_end', id: 't1' },
      { type: 'usage', inputTokens: 160, outputTokens: 42, cachedInputTokens: 40, cacheWriteTokens: 20 },
    ]);
  });

  it('emits a truncated chunk when stop_reason is max_tokens', async () => {
    anthropicState.events = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'cut off' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(makeAdapter().chat(baseMessages, { model: 'claude-x' }));
    expect(chunks.at(-1)).toEqual({ type: 'truncated' });
  });

  it('maps thinking block events into thinking_delta chunks', async () => {
    anthropicState.events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'let me think' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ' carefully' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the answer' } },
      { type: 'message_stop' },
    ];
    const chunks = await collect(makeAdapter().chat(baseMessages, { model: 'claude-x' }));
    expect(chunks).toEqual([
      { type: 'thinking_delta', content: 'let me think' },
      { type: 'thinking_delta', content: ' carefully' },
      { type: 'text_delta', content: 'the answer' },
      { type: 'usage', inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it('ignores json deltas without a current tool block and maps thrown errors', async () => {
    anthropicState.events = [
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'orphan' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const chunks = await collect(makeAdapter().chat(baseMessages, { model: 'claude-x' }));
    expect(chunks).toEqual([]); // no tool id tracked → deltas dropped, no end emitted
  });

  it('maps a throwing stream into an error chunk', async () => {
    anthropicState.events = [];
    const adapter = makeAdapter();
    // Override the fake stream to throw
    anthropicState.events = undefined as never;
    const throwing = {
      async *[Symbol.asyncIterator](): AsyncGenerator<never> {
        throw new Error('overloaded');
      },
    };
    (adapter as unknown as { client: { messages: { stream: () => unknown } } }).client.messages.stream =
      () => throwing;
    const chunks = await collect(adapter.chat(baseMessages, { model: 'claude-x' }));
    expect(chunks).toEqual([{ type: 'error', error: 'overloaded' }]);
  });
});

// ---- ollama adapter / provider --------------------------------------------

describe('OllamaAdapter boundaries (mocked fetch)', () => {
  it('falls back to the default localhost baseUrl when none given', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return { ok: false, status: 500, statusText: 'x' } as unknown as Response;
    }) as typeof fetch;
    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: '', model: 'llama3' } as never);
    await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    expect(capturedUrl).toBe('http://localhost:11434/api/chat');
  });

  it('reassembles JSON lines split across read chunks', async () => {
    const line1 = JSON.stringify({ message: { content: 'hel' } });
    const line2 = JSON.stringify({ message: { content: 'lo world' } });
    const line3 = JSON.stringify({ done: true });
    const full = `${line1}\n${line2}\n${line3}\n`;
    const mid = Math.floor(full.length / 2);
    const encoder = new TextEncoder();
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(full.slice(0, mid))); // splits a line in half
            controller.enqueue(encoder.encode(full.slice(mid)));
            controller.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;

    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: 'http://x', model: 'llama3' } as never);
    const chunks = await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    expect(chunks).toEqual([
      { type: 'text_delta', content: 'hel' },
      { type: 'text_delta', content: 'lo world' },
    ]);
  });

  it('streams a multi-part content array as-is (documented behavior)', async () => {
    const body = `${JSON.stringify({ message: { content: [{ type: 'text', text: 'part' }] } })}\n`;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;
    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: 'http://x', model: 'llama3' } as never);
    const chunks = await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    // Current behavior: the array is yielded verbatim as content
    expect(chunks).toEqual([{ type: 'text_delta', content: [{ type: 'text', text: 'part' }] }]);
  });

  it('emits a truncated chunk when done_reason is length', async () => {
    const body = `${JSON.stringify({ message: { content: 'partial' } })}
${JSON.stringify({ done: true, done_reason: 'length' })}
`;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;
    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: 'http://x', model: 'llama3' } as never);
    const chunks = await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    expect(chunks.at(-1)).toEqual({ type: 'truncated' });
  });

  it('maps the reasoning field into thinking_delta (thinking models)', async () => {
    const body = `${JSON.stringify({ message: { reasoning: 'pondering...' } })}
${JSON.stringify({ message: { content: 'answer' } })}
${JSON.stringify({ done: true })}
`;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;
    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: 'http://x', model: 'llama3' } as never);
    const chunks = await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    expect(chunks).toEqual([
      { type: 'thinking_delta', content: 'pondering...' },
      { type: 'text_delta', content: 'answer' },
    ]);
  });

  it('ends the stream on done even without a trailing newline', async () => {
    const body = `${JSON.stringify({ message: { content: 'tail' } })}\n${JSON.stringify({ done: true })}`;
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;
    const adapter = new OllamaAdapter({ apiKey: '', baseUrl: 'http://x', model: 'llama3' } as never);
    const chunks = await collect(adapter.chat([{ role: 'user', content: 'q' }], { model: 'llama3' }));
    expect(chunks).toEqual([{ type: 'text_delta', content: 'tail' }]);
  });
});

describe('OllamaProvider shell', () => {
  it('declares the ollama capability set and defaults the model', () => {
    const provider = new OllamaProvider({ name: 'ollama', apiKey: '', baseUrl: '', model: '' } as never);
    expect(provider.name).toBe('ollama');
    expect(provider.capabilities).toEqual({
      streaming: true,
      toolCalling: true,
      vision: false,
      maxContextLength: 32768,
      models: ['llama3', 'llama2', 'codellama', 'mistral', 'mixtral'],
    });
  });
});
