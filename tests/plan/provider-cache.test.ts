import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable state for the mocked SDKs
const mocks = vi.hoisted(() => ({
  anthropicCaptured: [] as Array<Record<string, unknown>>,
  anthropicEvents: [] as Array<Record<string, unknown>>,
  openaiCaptured: [] as Array<Record<string, unknown>>,
  openaiChunks: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      stream(params: Record<string, unknown>) {
        mocks.anthropicCaptured.push(params);
        return (async function* () {
          for (const event of mocks.anthropicEvents) {
            yield event;
          }
        })();
      },
    };
  }
  return { default: Anthropic };
});

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

import { AnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe('AnthropicProvider prompt caching', () => {
  beforeEach(() => {
    mocks.anthropicCaptured.length = 0;
    mocks.anthropicEvents.length = 0;
    mocks.anthropicEvents.push(
      { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 1 } } },
      { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'bash' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 50 } },
      { type: 'message_stop' },
    );
  });

  it('marks the system prompt with a cache_control breakpoint', async () => {
    const provider = new AnthropicProvider({ name: 'anthropic', apiKey: 'k' });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    await collect(provider.chat(messages, { model: 'claude', systemPrompt: 'You are Nova.' }));

    const params = mocks.anthropicCaptured[0];
    const system = params.system as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].text).toBe('You are Nova.');
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the last tool definition with a cache_control breakpoint', async () => {
    const provider = new AnthropicProvider({ name: 'anthropic', apiKey: 'k' });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const tools = [
      { type: 'function', function: { name: 'bash', description: 'd', parameters: {} } },
      { type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } },
    ];
    await collect(provider.chat(messages, { model: 'claude', systemPrompt: 'sys', tools: tools as never }));

    const params = mocks.anthropicCaptured[0];
    const sentTools = params.tools as Array<Record<string, unknown>>;
    expect(sentTools[0].cache_control).toBeUndefined();
    expect(sentTools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('keeps the first system message as system param and converts mid-history system messages to user context', async () => {
    const provider = new AnthropicProvider({ name: 'anthropic', apiKey: 'k' });
    const messages: Message[] = [
      { role: 'system', content: 'You are Nova.' },
      { role: 'user', content: 'q1' },
      { role: 'system', content: '## Active Skills\nRead the stack trace first.' },
      { role: 'user', content: 'q2' },
    ];
    await collect(provider.chat(messages, { model: 'claude' }));

    const params = mocks.anthropicCaptured[0];
    const sentMessages = params.messages as Array<{ role: string; content: unknown }>;

    // History order preserved, no system role inside messages
    expect(sentMessages.map((m) => m.role)).toEqual(['user', 'user', 'user']);
    expect(sentMessages[0].content).toBe('q1');
    expect(String(sentMessages[1].content)).toContain('## Active Skills');
    expect(String(sentMessages[1].content)).toContain('[context]');
    expect(sentMessages[2].content).toBe('q2');
  });

  it('emits normalized usage with cache read/write and streams tool calls with ids', async () => {
    const provider = new AnthropicProvider({ name: 'anthropic', apiKey: 'k' });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const chunks = await collect(provider.chat(messages, { model: 'claude', systemPrompt: 'sys' }));

    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      // normalized: input includes cached + cache-write
      inputTokens: 200,
      outputTokens: 50,
      cachedInputTokens: 80,
      cacheWriteTokens: 20,
    });

    const toolStart = chunks.find((c) => c.type === 'tool_call_start');
    expect(toolStart).toMatchObject({ type: 'tool_call_start', id: 't1', name: 'bash' });
    const toolDelta = chunks.find((c) => c.type === 'tool_call_delta');
    expect(toolDelta).toMatchObject({ type: 'tool_call_delta', id: 't1', arguments: '{"command":"ls"}' });
    const toolEnd = chunks.find((c) => c.type === 'tool_call_end');
    expect(toolEnd).toMatchObject({ type: 'tool_call_end', id: 't1' });
  });
});

describe('OpenAIProvider prompt caching', () => {
  beforeEach(() => {
    mocks.openaiCaptured.length = 0;
    mocks.openaiChunks.length = 0;
    mocks.openaiChunks.push(
      { choices: [{ delta: { content: 'hello' }, index: 0 }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    );
  });

  it('requests usage in the stream when promptCache is enabled', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', promptCache: true });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const chunks = await collect(provider.chat(messages, { model: 'gpt-4o', systemPrompt: 'sys' }));

    expect(mocks.openaiCaptured[0].stream_options).toEqual({ include_usage: true });

    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 100,
    });
  });

  it('does not request usage when promptCache is disabled', async () => {
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k' });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    await collect(provider.chat(messages, { model: 'gpt-4o', systemPrompt: 'sys' }));

    expect(mocks.openaiCaptured[0].stream_options).toBeUndefined();
  });
});
