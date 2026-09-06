import { describe, it, expect, vi } from 'vitest';
import { Compactor, SUMMARY_MARKER } from '../../src/agent/compaction.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';

function makeLLM(respond: (msgs: Message[], opts: ChatOptions) => StreamChunk[]): LLMProvider {
  return {
    async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      for (const chunk of respond(msgs, opts)) yield chunk;
    },
  };
}

describe('Compactor', () => {
  const model = 'test-model';
  const oldMessages: Message[] = [
    { role: 'user', content: 'Fix the bug in parser.ts' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"parser.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '1\tconst x = 1' },
    { role: 'assistant', content: 'Fixed the parser bug.' },
    { role: 'user', content: 'Now write tests' },
    { role: 'assistant', content: 'Tests written and passing.' },
  ];

  it('summarizes old messages and keeps the most recent ones', async () => {
    const chatCalls: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
    const llm = makeLLM((msgs, opts) => {
      chatCalls.push({ msgs, opts });
      return [{ type: 'text_delta', content: 'User wanted parser bug fix; tests were written.' }];
    });

    const compactor = new Compactor(llm, model, 2);
    const result = await compactor.compact(oldMessages);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(3); // summary + 2 kept
    expect(result![0].role).toBe('system');
    expect(result![0].content).toContain(SUMMARY_MARKER);
    expect(result![0].content).toContain('parser bug fix');
    expect(result!.slice(1)).toEqual(oldMessages.slice(-2));

    // Summary request must be tool-free
    expect(chatCalls[0].opts.tools).toBeUndefined();
    // Summary request includes the structured instruction and the transcript
    const requestMessages = chatCalls[0].msgs;
    expect(requestMessages[0].role).toBe('system');
    expect(requestMessages[0].content).toContain('User intent');
    expect(requestMessages[0].content).toContain('Files & changes');
    expect(requestMessages[0].content).toContain('Pending work');
    expect(requestMessages[1].role).toBe('user');
    expect(requestMessages[1].content).toContain('Conversation transcript:');
    // Transcript serialization: tool_calls rendered with name(args)
    expect(requestMessages[1].content).toContain('read_file({"path":"parser.ts"})');
    expect(requestMessages[1].content).toContain('[tool calls:');
    // Tool results rendered with the tool: prefix
    expect(requestMessages[1].content).toContain('tool: 1\tconst x = 1');
    // Transcript lines joined with newlines
    expect(requestMessages[1].content).toContain('user: Fix the bug in parser.ts\nassistant:');
    expect(requestMessages[1].content).toContain('\ntool: 1\tconst x = 1\nassistant:');
  });

  it('returns null when summarization fails (fail-open)', async () => {
    const llm = makeLLM(() => [{ type: 'error', error: 'boom' }]);
    const compactor = new Compactor(llm, model, 2);
    expect(await compactor.compact(oldMessages)).toBeNull();
  });

  it('returns null when the summary stream throws', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        throw new Error('socket reset');
      },
    };
    const compactor = new Compactor(llm, model, 2);
    expect(await compactor.compact(oldMessages)).toBeNull();
  });

  it('returns null when the summary is empty', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: '' }]);
    const compactor = new Compactor(llm, model, 2);
    expect(await compactor.compact(oldMessages)).toBeNull();
  });

  it('summarizes the older half when history is shorter than the keep count', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'short history summary' }]);
    const compactor = new Compactor(llm, model, 10);
    const short = [
      { role: 'user' as const, content: 'huge tool dump' },
      { role: 'assistant' as const, content: 'parsed it' },
      { role: 'user' as const, content: 'continue' },
    ];
    const result = await compactor.compact(short);
    expect(result).not.toBeNull();
    expect(result![0].content).toContain('short history summary');
    expect(result!.slice(1)).toEqual(short.slice(-1));
  });

  it('returns null for a single message (nothing to compact)', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'unused' }]);
    const compactor = new Compactor(llm, model, 10);
    const spy = vi.spyOn(llm, 'chat');
    const result = await compactor.compact([{ role: 'user', content: 'hi' }]);
    expect(result).toBeNull(); // nothing to compact
    expect(spy).not.toHaveBeenCalled();
  });
});
