import { describe, it, expect } from 'vitest';
import { Compactor } from '../../src/agent/compaction.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';
import type { ToolDefinition } from '../../src/llm/types.js';

// G19 (context-economics ticket 01): when the loop supplies the main-chain
// prefix, the summarization request must be that SAME prefix plus an appended
// instruction — so the provider serves the whole history from cache instead
// of re-billing a serialized transcript. Without the getter the legacy
// serialized-transcript request stays in place (old callers/tests unchanged).

function recordingLLM(captured: { messages?: Message[]; opts?: ChatOptions }): LLMProvider {
  return {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(messages: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      captured.messages = messages;
      captured.opts = opts;
      yield { type: 'text_delta', content: 'SUMMARY BODY' };
    },
  };
}

function history(): Message[] {
  return [
    { role: 'user', content: 'first ask' },
    { role: 'assistant', content: 'a very long assistant answer '.repeat(2000) },
    { role: 'user', content: 'second ask' },
    { role: 'assistant', content: 'another huge reply '.repeat(2000) },
    { role: 'user', content: 'third ask' },
    { role: 'assistant', content: 'tail answer '.repeat(400) },
  ];
}

const FROZEN = 'FROZEN SYSTEM PROMPT';
const TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'grep', description: 'd', parameters: { type: 'object', properties: {} } } },
];

describe('summary request reuses the main-chain prefix', () => {
  it('with getMainPrefix: request is the byte-identical history + appended instruction', async () => {
    const captured: { messages?: Message[]; opts?: ChatOptions } = {};
    const compactor = new Compactor(recordingLLM(captured), 'fake', {
      keepRecentTokens: 50,
      getMainPrefix: () => ({ systemPrompt: FROZEN, tools: TOOLS }),
    });
    const messages = history();
    const result = await compactor.compact(messages);
    expect(result?.method).toBe('summary');
    const sent = captured.messages!;
    // Everything but the final instruction equals the live array byte-for-byte.
    expect(JSON.stringify(sent.slice(0, -1))).toBe(JSON.stringify(messages));
    const instruction = sent[sent.length - 1];
    expect(instruction.role).toBe('user');
    expect(String(instruction.content)).toMatch(/Summarize the conversation/i);
    // Prefix parity also needs the same system prompt and tool definitions.
    expect(captured.opts?.systemPrompt).toBe(FROZEN);
    expect(captured.opts?.tools).toEqual(TOOLS);
  });

  it('without getMainPrefix: legacy serialized transcript request unchanged', async () => {
    const captured: { messages?: Message[]; opts?: ChatOptions } = {};
    const compactor = new Compactor(recordingLLM(captured), 'fake', { keepRecentTokens: 50 });
    await compactor.compact(history());
    const sent = captured.messages!;
    expect(sent).toHaveLength(2);
    expect(String(sent[0].content)).toMatch(/Summarize the conversation/i);
    expect(String(sent[1].content)).toContain('Conversation transcript:');
    expect(captured.opts?.systemPrompt).toBeUndefined();
  });

  it('summary output placement unchanged ([summary, ...kept])', async () => {
    const captured: { messages?: Message[]; opts?: ChatOptions } = {};
    const compactor = new Compactor(recordingLLM(captured), 'fake', {
      keepRecentTokens: 50,
      getMainPrefix: () => ({ systemPrompt: FROZEN, tools: TOOLS }),
    });
    const result = await compactor.compact(history());
    expect(String(result?.messages[0].content)).toContain('[Conversation summary]');
    expect(String(result?.messages[0].content)).toContain('SUMMARY BODY');
    expect(result!.messages.some((m) => m.role === 'user' && m.content === 'third ask')).toBe(true);
  });
});
