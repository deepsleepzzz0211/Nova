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
    expect(result!.messages[0].role).toBe('system');
    expect(result!.messages[0].content).toContain(SUMMARY_MARKER);
    expect(result!.messages[0].content).toContain('parser bug fix');

    // All user messages survive verbatim
    const keptUsers = result!.messages.filter((m) => m.role === 'user');
    expect(keptUsers.map((m) => m.content)).toEqual(['Fix the bug in parser.ts', 'Now write tests']);

    // The newest message is kept
    expect(result!.messages.at(-1)).toEqual(messages[5]);

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
    expect(result!.messages.some((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c1')).toBe(true);
    expect(result!.messages.some((m) => m.role === 'assistant' && 'tool_calls' in m)).toBe(true);
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
    expect(result!.messages.at(-1)).toEqual(messages[3]);
  });

  it('reports summarized=false when there is nothing to summarize (all within budget)', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'unused' }]);
    const spy = vi.spyOn(llm, 'chat');
    const compactor = new Compactor(llm, model, { keepRecentTokens: 100_000, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(result!.messages).toEqual(messages);
    expect(spy).not.toHaveBeenCalled();
  });

  it('placeholder pass clears old tool results without calling the LLM', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'should not be called' }]);
    const spy = vi.spyOn(llm, 'chat');
    const big = 'x'.repeat(4000); // ~1000 tokens
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: big },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'small reply' },
    ];
    // trigger: after clearing the old tool result the context fits
    const compactor = new Compactor(llm, model, {
      keepRecentTokens: msgEstimate(messages[4]) + msgEstimate(messages[3]),
      countTokens: est,
      triggerTokens: 400,
    });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('placeholder'); // no LLM call needed
    expect(spy).not.toHaveBeenCalled();
    // Old tool result replaced with a placeholder, identity preserved
    const toolMsg = result!.messages.find((m) => m.role === 'tool') as { content: string; tool_call_id?: string };
    expect(toolMsg.tool_call_id).toBe('c1');
    expect(toolMsg.content).toContain('cleared');
    expect(toolMsg.content).toContain('4000');
    expect(toolMsg.content).not.toContain(big);
    // Kept messages untouched
    expect(result!.messages.at(-1)).toEqual(messages[4]);
  });

  it('falls through to the LLM summary when placeholders are not enough', async () => {
    const chatCalls: Array<{ msgs: Message[] }> = [];
    const llm: LLMProvider = {
      async *chat(msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
        chatCalls.push({ msgs });
        yield { type: 'text_delta', content: 'full summary' };
      },
    };
    const big = 'y'.repeat(8000); // ~2000 tokens — placeholder alone won't fit
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: big },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'z'.repeat(1200) }, // kept-verbatim newest reply (~300 tokens, can't be cleared)
    ];
    const compactor = new Compactor(llm, model, {
      keepRecentTokens: msgEstimate(messages[4]) + msgEstimate(messages[3]),
      countTokens: est,
      triggerTokens: 300,
    });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    expect(result!.messages[0].role).toBe('system');
    // Serialization: the giant tool result is capped at 2000 chars
    const transcript = chatCalls[0].msgs[1].content ?? '';
    expect(transcript).toContain('y'.repeat(2000));
    expect(transcript).not.toContain('y'.repeat(2001));
    expect(transcript).toContain('chars truncated');
  });

  it('handles 6 oversized tool results: recent ones kept, old ones summarized', async () => {
    let summaryCalls = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        summaryCalls++;
        yield { type: 'text_delta', content: 'summary of old tool results' };
      },
    };
    const big = 't'.repeat(4000); // ~1000 tokens each
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `step ${i}` });
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.ts"}` } }],
      });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: big });
    }

    // Budget admits the last ~2 pairs only (~2100 tokens); the rest must
    // be summarized, never dropped.
    const compactor = new Compactor(llm, model, {
      keepRecentTokens: msgEstimate(messages[13]) + msgEstimate(messages[14]) + msgEstimate(messages[15]),
      countTokens: est,
    });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    expect(summaryCalls).toBe(1);
    // Only the last tool result survives verbatim
    const keptTools = result!.messages.filter((m) => m.role === 'tool' && m.content === big);
    expect(keptTools).toHaveLength(1);
    expect((keptTools[0] as { tool_call_id?: string }).tool_call_id).toBe('c5');
    // Summary present
    expect(result!.messages[0].content).toContain(SUMMARY_MARKER);
  });

  it('treats a user message as the newest when it ends the history (walk skips users)', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'summary' }]);
    const messages: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2 latest' },
    ];
    // Tiny budget: a1 must be summarized; the newest is u2 (a user), which
    // is kept regardless — the always-keep exemption must not leak onto a1.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    const keptUsers = result!.messages.filter((m) => m.role === 'user');
    expect(keptUsers.map((m) => m.content)).toEqual(['u1', 'u2 latest']);
    expect(result!.messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('tool-batch owner resolution matches the exact tool_call id', async () => {
    let summaryCalls = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        summaryCalls++;
        yield { type: 'text_delta', content: 'summary' };
      },
    };
    const messages: Message[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(400) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(400) },
      { role: 'assistant', content: 'small' },
    ];
    // Budget admits [r2(c2) + a3]; the naive boundary lands on r2 → the
    // owner search must pull a2 (owner of c2), NOT a1 (owner of c1).
    const budget = msgEstimate(messages[4]) + msgEstimate(messages[5]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: budget, countTokens: est });
    const result = await compactor.compact(messages);

    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    // c2 pair kept together; c1 pair summarized together (never split)
    const kept = result!.messages;
    expect(kept.some((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c2')).toBe(true);
    expect(kept.some((m) => m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.[0]?.id === 'c2')).toBe(true);
    expect(kept.some((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c1')).toBe(false);
    expect(summaryCalls).toBe(1);
  });

  it('reports summarized=false for a single message', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: 'unused' }]);
    const spy = vi.spyOn(llm, 'chat');
    const compactor = new Compactor(llm, model, { keepRecentTokens: 100, countTokens: est });
    const r = await compactor.compact([{ role: 'user', content: 'hi' }]);
    expect(r!.method).toBe('none');
    expect(r!.messages).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null when summarization fails (caller falls back)', async () => {
    const llm = makeLLM(() => [{ type: 'error', error: 'boom' }]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull(); // null = summary failure
  });

  it('returns null when the summary stream throws', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        throw new Error('socket reset');
      },
    };
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull(); // null = summary failure
  });

  it('returns null when the summary is empty', async () => {
    const llm = makeLLM(() => [{ type: 'text_delta', content: '' }]);
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(await compactor.compact(messages)).toBeNull(); // null = summary failure
  });
});
