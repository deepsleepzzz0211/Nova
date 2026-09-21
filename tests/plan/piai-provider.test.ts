import { describe, it, expect } from 'vitest';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxProviderHandle,
} from '@earendil-works/pi-ai';
import type { Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createPiaiEngine, type PiaiEngine } from '../../src/llm/piai-engine.js';
import { PiProvider } from '../../src/llm/providers/piai.js';
import type { Message, StreamChunk, ToolDefinition } from '../../src/llm/types.js';

/**
 * Ticket 03 — PiProvider implements Nova's LLMProvider on top of the pi-ai
 * Models collection (engine.models.streamSimple), with the ticket-02 bridge
 * converting in both directions. These tests inject pi-ai's faux provider
 * into the engine, so the whole path (options → Context → wire events →
 * StreamChunks) runs end to end without network.
 */

interface Captured {
  context?: Context;
  options?: SimpleStreamOptions;
  model?: Model<string>;
}

function setup(overrides?: { baseUrl?: string; reasoning?: boolean }): {
  engine: PiaiEngine;
  faux: FauxProviderHandle;
  capture: Captured;
  provider: PiProvider;
} {
  const engine = createPiaiEngine();
  // Default to a reasoning-capable model: most request-translation tests check
  // that levels/params reach pi-ai verbatim; ticket 04 clamps against the
  // model's capability, so the model must advertise reasoning for pass-through.
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-1', reasoning: overrides?.reasoning ?? true }],
  });
  engine.models.setProvider(faux.provider);

  const capture: Captured = {};
  const provider = new PiProvider({
    engine,
    provider: 'faux',
    model: faux.models[0]!.id,
    apiKey: 'test-key',
    ...(overrides?.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
  });
  return { engine, faux, capture, provider };
}

function captureStep(capture: Captured, text: string) {
  return (context: Context, options: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) => {
    capture.context = context;
    capture.options = options;
    capture.model = model;
    return fauxAssistantMessage(text);
  };
}

async function collect(
  provider: PiProvider,
  messages: Message[],
  options: Parameters<PiProvider['chat']>[1],
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.chat(messages, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('PiProvider.chat end to end', () => {
  it('streams a text answer with usage, matching old adapter chunk vocabulary', async () => {
    const { faux, provider } = setup();
    faux.setResponses([fauxAssistantMessage('hello world')]);

    const chunks = await collect(provider, [{ role: 'user', content: 'greet me' }], {
      model: faux.models[0]!.id,
    });

    const text = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => (c as { content: string }).content)
      .join('');
    expect(text).toBe('hello world');
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
    expect(chunks.some((c) => c.type === 'error' || c.type === 'truncated')).toBe(false);
  });

  it('streams a tool-call batch (start/deltas/end) through the bridge', async () => {
    const { faux, provider } = setup();
    faux.setResponses([
      fauxAssistantMessage([
        { type: 'text', text: 'working' },
        fauxToolCall('read_file', { path: 'a.txt' }, { id: 'call_1' }),
      ]),
    ]);

    const chunks = await collect(provider, [{ role: 'user', content: 'read a.txt' }], {
      model: faux.models[0]!.id,
    });

    const start = chunks.find((c) => c.type === 'tool_call_start');
    expect(start).toEqual({ type: 'tool_call_start', id: 'call_1', name: 'read_file' });
    const args = chunks
      .filter((c) => c.type === 'tool_call_delta')
      .map((c) => (c as { arguments: string }).arguments)
      .join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.txt' });
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(true);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
  });

  it('maps a length-stopped response to a truncated chunk', async () => {
    const { faux, provider } = setup();
    faux.setResponses([fauxAssistantMessage('cut off', { stopReason: 'length' })]);

    const chunks = await collect(provider, [{ role: 'user', content: 'long' }], {
      model: faux.models[0]!.id,
    });
    expect(chunks.some((c) => c.type === 'truncated')).toBe(true);
  });

  it('streams a model id absent from the catalog verbatim (old-adapter parity)', async () => {
    const { faux, provider, capture } = setup();
    // The wire accepts any served id; PiProvider falls back to a template
    // model from the same provider and only swaps the id (vLLM/ollama case).
    faux.setResponses([captureStep(capture, 'served anyway')]);

    const chunks = await collect(provider, [{ role: 'user', content: 'hi' }], {
      model: 'some-new-model-not-in-catalog',
    });
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(capture.model!.id).toBe('some-new-model-not-in-catalog');
  });

  it('reports an unknown provider as an error chunk (adapter-equivalent semantics)', async () => {
    const engine = createPiaiEngine();
    const provider = new PiProvider({ engine, provider: 'no-such-provider', model: 'm', apiKey: 'k' });
    const chunks = await collect(provider, [{ role: 'user', content: 'hi' }], {
      model: 'no-such-model',
    });
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('no-such-provider') }]);
  });
});

describe('PiProvider request translation', () => {
  it('passes system prompt, history and tools into the pi-ai Context', async () => {
    const { faux, provider, capture } = setup();
    faux.setResponses([captureStep(capture, 'ok')]);

    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } },
      },
    ];
    await collect(
      provider,
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'body' },
      ],
      { model: faux.models[0]!.id, tools, systemPrompt: 'You are Nova.' },
    );

    expect(capture.context!.systemPrompt).toBe('You are Nova.');
    expect(capture.context!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(capture.context!.tools?.map((t) => t.name)).toEqual(['read_file']);
  });

  it('maps thinkingLevel to pi reasoning, with off omitted', async () => {
    const { faux, provider, capture } = setup();
    faux.setResponses([captureStep(capture, 'a'), captureStep(capture, 'b')]);

    await collect(provider, [{ role: 'user', content: 'hi' }], {
      model: faux.models[0]!.id,
      thinkingLevel: 'high',
    });
    expect(capture.options!.reasoning).toBe('high');

    await collect(provider, [{ role: 'user', content: 'hi' }], {
      model: faux.models[0]!.id,
      thinkingLevel: 'off',
    });
    expect(capture.options!.reasoning).toBeUndefined();
  });

  it('forwards maxTokens, temperature and the resolved api key', async () => {
    const { faux, provider, capture } = setup();
    faux.setResponses([captureStep(capture, 'a')]);

    await collect(provider, [{ role: 'user', content: 'hi' }], {
      model: faux.models[0]!.id,
      maxTokens: 1234,
      temperature: 0.3,
    });
    expect(capture.options!.maxTokens).toBe(1234);
    expect(capture.options!.temperature).toBe(0.3);
    expect(capture.options!.apiKey).toBe('test-key');
  });

  it('applies a Nova baseUrl override onto the model used for the request', async () => {
    const { faux, provider, capture } = setup({ baseUrl: 'https://proxy.example/v1' });
    faux.setResponses([captureStep(capture, 'a')]);
    await collect(provider, [{ role: 'user', content: 'hi' }], { model: faux.models[0]!.id });
    expect(capture.model!.baseUrl).toBe('https://proxy.example/v1');
  });
});

describe('PiProvider interrupt (old-SDK abort parity)', () => {
  it('passes an abort signal to the pi-ai request', async () => {
    const { faux, provider, capture } = setup();
    faux.setResponses([captureStep(capture, 'a')]);
    await collect(provider, [{ role: 'user', content: 'hi' }], { model: faux.models[0]!.id });
    expect(capture.options!.signal).toBeInstanceOf(AbortSignal);
    expect(capture.options!.signal!.aborted).toBe(false);
  });

  it('aborts the request when the consumer walks away mid-stream', async () => {
    const { faux, provider, capture } = setup();
    faux.setResponses([captureStep(capture, 'hello there this streams')]);
    const gen = provider.chat([{ role: 'user', content: 'hi' }], {
      model: faux.models[0]!.id,
    });
    await gen.next(); // park the generator at its first yielded chunk
    await gen.return(undefined); // what `break` in a for-await does
    expect(capture.options!.signal!.aborted).toBe(true);
  });
});

describe('PiProvider surface parity', () => {
  it('exposes the provider name and engine-backed capabilities', async () => {
    const { faux, provider } = setup();
    expect(provider.name).toBe('faux');
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.toolCalling).toBe(true);
    expect(provider.capabilities.maxContextLength).toBe(faux.models[0]!.contextWindow);
    expect(provider.capabilities.models).toContain(faux.models[0]!.id);
  });
});
