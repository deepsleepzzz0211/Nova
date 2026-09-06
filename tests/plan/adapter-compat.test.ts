import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  openaiCaptured: [] as Array<Record<string, unknown>>,
  openaiChunks: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => {
  class OpenAI {
    chat = {
      completions: {
        create(params: Record<string, unknown>) {
          mocks.openaiCaptured.push(params);
          return (async function* () {
            for (const chunk of mocks.openaiChunks) {
              yield chunk;
            }
          })();
        },
      },
    };
  }
  return { default: OpenAI };
});

import { OpenAIProvider } from '../../src/llm/openai.js';
import { LLMProviderRegistry } from '../../src/llm/registry.js';
import { AnthropicProvider } from '../../src/llm/providers/anthropic.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('openai-completions adapter compat flags', () => {
  beforeEach(() => {
    mocks.openaiCaptured.length = 0;
    mocks.openaiChunks.length = 0;
    mocks.openaiChunks.push({ choices: [{ delta: { content: 'ok' }, index: 0 }] });
  });

  const messages: Message[] = [{ role: 'user', content: 'hi' }];
  const chat = { model: 'gpt-4o', systemPrompt: 'You are Nova.' };

  it('sends the system prompt as a system message by default', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    await collect(provider.chat(messages, chat));
    const sent = mocks.openaiCaptured[0].messages as Array<{ role: string }>;
    expect(sent[0].role).toBe('system');
  });

  it('sends the system prompt as a developer message when supportsDeveloperRole is true', async () => {
    const provider = new OpenAIProvider({
      name: 'openai',
      apiKey: 'k',
      compat: { supportsDeveloperRole: true },
    });
    await collect(provider.chat(messages, chat));
    const sent = mocks.openaiCaptured[0].messages as Array<{ role: string }>;
    expect(sent[0].role).toBe('developer');
    expect((sent[0] as { content: string }).content).toBe('You are Nova.');
  });

  it('enables stream usage reporting when compat.streamUsage is true', async () => {
    const provider = new OpenAIProvider({
      name: 'openai',
      apiKey: 'k',
      compat: { streamUsage: true },
    });
    await collect(provider.chat(messages, chat));
    expect(mocks.openaiCaptured[0].stream_options).toEqual({ include_usage: true });
  });

  it('keeps promptCache as a deprecated alias of streamUsage', async () => {
    const provider = new OpenAIProvider({
      name: 'openai',
      apiKey: 'k',
      compat: { promptCache: true },
    });
    await collect(provider.chat(messages, chat));
    expect(mocks.openaiCaptured[0].stream_options).toEqual({ include_usage: true });
  });
});

describe('provider selection by API id', () => {
  it('maps api ids to the right provider class', () => {
    const registry = new LLMProviderRegistry();
    expect(registry.getForApi('openai-completions', { name: 'x', apiKey: 'k' })).toBeInstanceOf(OpenAIProvider);
    expect(registry.getForApi('anthropic-messages', { name: 'x', apiKey: 'k' })).toBeInstanceOf(AnthropicProvider);
  });

  it('throws for an unknown api id', () => {
    const registry = new LLMProviderRegistry();
    expect(() => registry.getForApi('nope' as never, { name: 'x' })).toThrow(/Unknown API/);
  });
});
