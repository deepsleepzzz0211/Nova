import { describe, it, expect, afterEach } from 'vitest';
import { OllamaAdapter } from '../../src/llm/adapters/ollama.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';

const originalFetch = globalThis.fetch;

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('OllamaAdapter (mocked fetch)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  const adapter = new OllamaAdapter({
    apiKey: undefined,
    baseUrl: 'http://localhost:11434',
    model: 'llama3',
    compat: { supportsDeveloperRole: false, streamUsage: false },
  });

  it('streams text deltas and stops on done', async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { message: { content: 'Hel' } },
        { message: { content: 'lo' } },
        { done: true },
      ])) as typeof fetch;

    const chunks = await collect(adapter.chat(messages, { model: 'llama3' }));
    expect(chunks).toEqual([
      { type: 'text_delta', content: 'Hel' },
      { type: 'text_delta', content: 'lo' },
    ]);
  });

  it('sends the system prompt and sampling options', async () => {
    let capturedBody: { messages: Array<{ role: string }>; options: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (_url: string, init?: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return ndjsonResponse([{ done: true }]);
    }) as typeof fetch;

    await collect(adapter.chat(messages, { model: 'llama3', systemPrompt: 'sys', maxTokens: 100, temperature: 0.5 }));
    expect(capturedBody!.messages[0].role).toBe('system');
    expect(capturedBody!.options).toEqual({ num_predict: 100, temperature: 0.5 });
  });

  it('reports HTTP errors as error chunks', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 500, statusText: 'Internal Error' }) as unknown as Response) as typeof fetch;

    const chunks = await collect(adapter.chat(messages, { model: 'llama3' }));
    expect(chunks[0]).toEqual({ type: 'error', error: 'Ollama API error: 500 Internal Error' });
  });

  it('reports a missing body as an error chunk', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, body: null }) as unknown as Response) as typeof fetch;
    const chunks = await collect(adapter.chat(messages, { model: 'llama3' }));
    expect(chunks[0]).toEqual({ type: 'error', error: 'No response body' });
  });

  it('skips invalid JSON lines without failing', async () => {
    const body = 'not-json\n' + JSON.stringify({ message: { content: 'ok' } }) + '\n' + JSON.stringify({ done: true }) + '\n';
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
      }) as unknown as Response) as typeof fetch;

    const chunks = await collect(adapter.chat(messages, { model: 'llama3' }));
    expect(chunks).toEqual([{ type: 'text_delta', content: 'ok' }]);
  });

  it('wraps unexpected exceptions into error chunks', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const chunks = await collect(adapter.chat(messages, { model: 'llama3' }));
    expect(chunks[0]).toEqual({ type: 'error', error: 'network down' });
  });
});
