import { describe, it, expect } from 'vitest';
import type { StreamChunk } from '../../src/llm/types.js';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.js';

// Re-export parseOpenAIStream for testing
import { parseOpenAIStream } from '../../src/llm/stream.js';

/** Helper to create a mock async iterable from chunk objects */
async function* mockStream(chunks: ChatCompletionChunk[]): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Helper to collect all chunks from the parser */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Create a minimal ChatCompletionChunk */
function makeChunk(
  choices: ChatCompletionChunk['choices'],
  overrides: Partial<ChatCompletionChunk> = {},
): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    choices,
    created: Date.now(),
    model: 'gpt-4',
    object: 'chat.completion.chunk',
    ...overrides,
  };
}

describe('parseOpenAIStream', () => {
  it('yields text_delta for content chunks', async () => {
    const stream = mockStream([
      makeChunk([{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]),
      makeChunk([{ index: 0, delta: { content: ' world' }, finish_reason: null }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'text_delta', content: 'Hello' },
      { type: 'text_delta', content: ' world' },
    ]);
  });

  it('yields tool_call_start when id and name appear', async () => {
    const stream = mockStream([
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'tool_call_start', id: 'call_abc', name: 'read_file' },
      { type: 'tool_call_end', id: 'call_abc' },
    ]);
  });

  it('yields tool_call_delta for argument fragments', async () => {
    const stream = mockStream([
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '{"path' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '": "test.ts"}' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'tool_call_start', id: 'call_abc', name: 'read_file' },
      { type: 'tool_call_delta', id: 'call_abc', arguments: '{"path' },
      { type: 'tool_call_delta', id: 'call_abc', arguments: '": "test.ts"}' },
      { type: 'tool_call_end', id: 'call_abc' },
    ]);
  });

  it('handles multiple concurrent tool calls by index', async () => {
    const stream = mockStream([
      // Both tool calls start
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } },
            { index: 1, id: 'call_2', type: 'function', function: { name: 'write_file', arguments: '' } },
          ],
        },
        finish_reason: null,
      }]),
      // Arguments arrive interleaved
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '{"path":' } },
            { index: 1, function: { arguments: '{"path":' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '"a.ts"}' } },
            { index: 1, function: { arguments: '"b.ts","content":"' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: 'hello"}' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'tool_call_start', id: 'call_1', name: 'read_file' },
      { type: 'tool_call_start', id: 'call_2', name: 'write_file' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '{"path":' },
      { type: 'tool_call_delta', id: 'call_2', arguments: '{"path":' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '"a.ts"}' },
      { type: 'tool_call_delta', id: 'call_2', arguments: '"b.ts","content":"' },
      { type: 'tool_call_delta', id: 'call_2', arguments: 'hello"}' },
      { type: 'tool_call_end', id: 'call_1' },
      { type: 'tool_call_end', id: 'call_2' },
    ]);
  });

  it('flushes remaining tool_calls at stream end (safety flush)', async () => {
    // Some APIs send stop without tool_calls finish_reason
    const stream = mockStream([
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'tool_call_start', id: 'call_x', name: 'bash' },
      { type: 'tool_call_delta', id: 'call_x', arguments: '{"cmd":"ls"}' },
      { type: 'tool_call_end', id: 'call_x' },
    ]);
  });

  it('handles empty choices array', async () => {
    const stream = mockStream([
      makeChunk([]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([]);
  });

  it('handles mixed text and tool calls', async () => {
    const stream = mockStream([
      // Text first
      makeChunk([{ index: 0, delta: { content: 'Let me ' }, finish_reason: null }]),
      makeChunk([{ index: 0, delta: { content: 'help.\n' }, finish_reason: null }]),
      // Then tool call
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_mix', type: 'function', function: { name: 'read', arguments: '{"f":"' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: 'test"}' } },
          ],
        },
        finish_reason: null,
      }]),
      makeChunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
    ]);

    const result = await collect(parseOpenAIStream(stream));
    expect(result).toEqual([
      { type: 'text_delta', content: 'Let me ' },
      { type: 'text_delta', content: 'help.\n' },
      { type: 'tool_call_start', id: 'call_mix', name: 'read' },
      { type: 'tool_call_delta', id: 'call_mix', arguments: '{"f":"' },
      { type: 'tool_call_delta', id: 'call_mix', arguments: 'test"}' },
      { type: 'tool_call_end', id: 'call_mix' },
    ]);
  });
});

describe('LLMProvider interface', () => {
  it('OpenAIProvider can be imported and implements chat()', async () => {
    const { OpenAIProvider } = await import('../../src/llm/openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    expect(provider.chat).toBeDefined();
    expect(typeof provider.chat).toBe('function');
  });
});
