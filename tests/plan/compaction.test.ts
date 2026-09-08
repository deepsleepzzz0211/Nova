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

/** Deterministic estimator: 1 token per 4 chars (rounded up). */
const est = (text: string): number => Math.ceil(text.length / 4);

function msgEstimate(msg: Message): number {
  let t = 8;
  if (msg.content) t += est(msg.content);
  if ('tool_calls' in msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) t += est(tc.function.name) + est(tc.function.arguments);
  }
  return t;
}

describe('Compactor (token-budget keep window)', () => {
  const model = 'test-model';

  it('keeps recent messages within the token budget and summarizes the rest', async () => {
    const chatCalls: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
    const llm = makeLLM((msgs, opts) => {
      chatCalls.push({ msgs, opts });
      return [{ type: 'text_delta', content: 'User wanted parser bug fix; tests were written.' }];
    });

    const messages: Message[] = [
      { role: 'user', content: 'Fix the bug in parser.ts' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"parser.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '1\tconst x = 1' },
      { role: 'assistant', content: 'Fixed the parser bug.' },
      { role: 'user', content: 'Now write tests' },
      { role: 'assistant', content: 'Tests written and passing.' },
    ];

    // Budget admits only the last message
    const lastEst = msgEstimate(messages[5]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: lastEst, countTokens: est });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    // summary + all user messages (verbatim) + newest non-user message
    expect(result![0].role).toBe('system');
    expect(result![0].content).toContain(SUMMARY_MARKER);
    expect(result![0].content).toContain('parser bug fix');

    // All user messages survive verbatim
    const keptUsers = result!.filter((m) => m.role === 'user');
    expect(keptUsers.map((m) => m.content)).toEqual(['Fix the bug in parser.ts', 'Now write tests']);

    // The newest message is kept
    expect(result!.at(-1)).toEqual(messages[5]);

    // Summary request must be tool-free and structured
    expect(chatCalls[0].opts.tools).toBeUndefined();
    expect(chatCalls[0].msgs[0].role).toBe('system');
    expect(chatCalls[0].msgs[0].content).toContain('User intent');
    expect(chatCalls[0].msgs[1].content).toContain('Conversation transcript:');
    expect(chatCalls[0].msgs[1].content).toContain('read_file({"path":"parser.ts"})');
    // User messages are NOT sent to the summarizer (they are kept verbatim)
    expect(chatCalls[0].msgs[1].content).not.toContain('Fix the bug in parser.ts');
    expect(chatCalls[0].msgs[1].content).not.toContain('Now write tests');
  });

  it('never splits a tool call from its result at the cut point', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'summary' }]);

    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'old work' },
      { role: 'assistant', content: 'searching', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"auth"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'small' },
    ];

    // Budget admits exactly [tool result + newest assistant] but NOT the
    // owning assistant — so the naive boundary lands on the tool result,
    // splitting the pair. The cut-point rule must pull the owner back in.
    const budget = msgEstimate(messages[3]) + msgEstimate(messages[4]);
    const chatCalls: Array<{ msgs: Message[] }> = [];
    const llm2: LLMProvider = {
      async *chat(msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
        chatCalls.push({ msgs });
        yield { type: 'text_delta', content: 'summary' };
      },
    };
    const compactor = new Compactor(llm2, model, { keepRecentTokens: budget, countTokens: est });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    // Tool result and its owning assistant message are BOTH kept
    expect(result!.some((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c1')).toBe(true);
    expect(result!.some((m) => m.role === 'assistant' && 'tool_calls' in m)).toBe(true);
    // The pre-boundary message was summarized (sent to the summarizer),
    // not silently dropped
    expect(chatCalls[0].msgs[1].content).toContain('old work');
  });

  it('always keeps the newest message even when it alone exceeds the budget', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'summary' }]);
    const huge = 'y'.repeat(40_000); // ~10k tokens, over any small budget
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: huge },
      { role: 'user', content: 'and then?' },
      { role: 'assistant', content: huge },
    ];
    const compactor = new Compactor(llm, model, { keepRecentTokens: 100, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.at(-1)).toEqual(messages[3]);
  });

  it('returns null when there is nothing to summarize (all within budget)', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'unused' }]);
    const spy = vi.spyOn(llm, 'chat');
    const compactor = new Compactor(llm, model, { keepRecentTokens: 100_000, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(await compactor.compact(messages)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null for a single message', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'unused' }]);
    const spy = vi.spyOn(llm, 'chat');
    const compactor = new Compactor(llm, model, { keepRecentTokens: 100, countTokens: est });
    expect(await compactor.compact([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null when summarization fails (fail-open)', async () => {
    const llm = makeLLM(() => [{ type: 'error', error: 'boom' }]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: 50, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull();
  });

  it('returns null when the summary stream throws', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        throw new Error('socket reset');
      },
    };
    const compactor = new Compactor(llm, model, { keepRecentTokens: 50, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull();
  });

  it('returns null when the summary is empty', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: '' }]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: 50, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull();
  });
});
