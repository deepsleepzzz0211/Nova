import { describe, it, expect } from 'vitest';
import { Compactor, SUMMARY_MARKER } from '../../src/agent/compaction.js';
import { MICROCOMPACT_MARKER } from '../../src/agent/microcompact.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';
import type { LLMProvider as Provider } from '../../src/llm/provider.js';

function makeLLM(chunks: StreamChunk[]): Provider & { chatCalls: Array<{ msgs: Message[]; opts: ChatOptions }> } {
  const chatCalls: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
  return {
    chatCalls,
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      chatCalls.push({ msgs, opts });
      for (const c of chunks) yield c;
    },
  };
}

/** Deterministic estimator mirroring the production default: ceil(len/4). */
const est = (text: string): number => Math.ceil(text.length / 4);

const ok = (content = 'summary text'): StreamChunk[] => [{ type: 'text_delta', content }];

/**
 * Precision net for the survived-mutant cluster in src/agent/compaction.ts
 * (survived hunt 2/3, ticket 03). Each case pins an exact boundary value or
 * exact output string that the loose `toContain` assertions in
 * compaction.test.ts left unconstrained.
 */
describe('Compactor edge cases (mutant hunts)', () => {
  const model = 'test-model';

  it('default token estimator is ceil(len/4): 40-char reply costs 8+10 and stays within an 18 budget', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'x'.repeat(40) },
      { role: 'user', content: 'q2' },
    ];
    // No countTokens option → exercises the built-in `text.length / 4` heuristic.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 18 });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('tool-call args count toward the keep-window cost and force summarization', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'r', arguments: 'a'.repeat(32) } }] },
      { role: 'user', content: 'q2' },
    ];
    // assistant cost = 8 framing + est('r')=1 + est(32 chars)=8 = 17 > budget 10.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 10, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    const transcript = llm.chatCalls[0].msgs[1].content ?? '';
    expect(transcript).toContain(`r(${'.repeat'.slice(0, 0)}${'a'.repeat(32)})`);
  });

  it('user messages cost no keep-window budget no matter how large', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'u'.repeat(200) },
      { role: 'assistant', content: 'x'.repeat(8) },
      { role: 'user', content: 'last' },
    ];
    // assistant costs 8+2=10 ≤ 20; the 200-char user must not consume budget.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 20, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('boundary walk evaluates the very first message (index 0) like any other', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'assistant', content: 'x'.repeat(8) },
      { role: 'user', content: 'q' },
    ];
    // cost(assistant)=10 ≤ 10 → boundary 0 → everything kept → 'none'.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 10, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
  });

  it('orphan tool result with no owner anywhere collapses the boundary to 0 and keeps everything', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'u' },
      { role: 'tool', tool_call_id: 'c9', content: 't'.repeat(8) },
      { role: 'user', content: 'v' },
    ];
    // tool cost 8+2=10 ≤ 10 → boundary 1 → tool at boundary → owner search
    // runs to index 0 without a match → boundary 0 → nothing to summarize.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 10, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('owner of a multi-call batch matches when only one call in the batch is at the boundary', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'o'.repeat(40) },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(4) },
      { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(4) },
      { role: 'assistant', content: 'last' },
    ];
    // budget 20 keeps both tool results (9+9), breaks on the batch owner
    // (cost 8+2+2=12 > 2) → boundary lands on tool c1 → owner search must
    // match via `some` (c1 is in the batch) and pull the whole batch back.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 20, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');
    const transcript = llm.chatCalls[0].msgs[1].content ?? '';
    expect(transcript).toContain('o'.repeat(40));
    const kept = result!.messages;
    expect(kept.some((m) => 'tool_calls' in m && m.tool_calls?.some((tc) => tc.id === 'c1'))).toBe(true);
    expect(kept.some((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c2')).toBe(true);
  });

  it('assistant message with tool_calls explicitly undefined is skipped by the owner search, not a crash', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'mid', tool_calls: undefined } as Message,
      { role: 'assistant', content: 'p'.repeat(40) },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(12) },
      { role: 'assistant', content: 'last' },
    ];
    // budget 20: tool (cost 11) kept → boundary 3; 'p'*40 assistant (cost
    // 8+10=18 > 9) breaks. Boundary is the tool → owner search visits the
    // undefined-tool_calls assistant (present key, must not deref) and finds
    // no owner anywhere → boundary 0 → everything kept → 'none'.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 20, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('owner search stops at the message whose tool_calls actually contain the id, skipping decoy assistants', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c5', type: 'function', function: { name: 'real', arguments: '{}' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'cX', type: 'function', function: { name: 'decoy', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c5', content: 'x'.repeat(12) },
      { role: 'assistant', content: 'last' },
    ];
    // budget 20: newest a4 (9) then tool (11) stay, the decoy (cost 11 > 0)
    // breaks → boundary lands on the tool. Owner of c5 is index 1, NOT the
    // closer decoy at index 2. If the match condition degraded to
    // "assistant with any tool_calls", boundary would be 2 and the real
    // owner would be summarized → method 'summary'.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 20, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('none');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('serializeTranscript produces the exact per-role wire format for every message shape', async () => {
    const llm = makeLLM(ok());
    const longE = 'e'.repeat(2000);
    const messages: Message[] = [
      {
        role: 'assistant', content: 'AC', thinking: 'TH', tool_calls: [
          { id: 'a1', type: 'function', function: { name: 'grep', arguments: '{"p":1}' } },
          { id: 'a2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      } as Message,
      { role: 'assistant', content: null, tool_calls: [{ id: 'b1', type: 'function', function: { name: 'x', arguments: 'y' } }] },
      { role: 'assistant', content: 'CC', thinking: 'CTH' } as Message,
      { role: 'tool', tool_call_id: 'd1', content: 'd'.repeat(2001) },
      { role: 'tool', tool_call_id: 'e1', content: longE },
      { role: 'tool', tool_call_id: 'f1', content: 'small' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'keepme' },
    ];
    // Tiny budget: everything except the newest message is summarized.
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('summary');

    const call = llm.chatCalls[0];
    expect(call.opts).toEqual({ model });
    expect(call.msgs).toHaveLength(2);
    expect(call.msgs[0].role).toBe('system');
    expect(call.msgs[1].content).toBe(`Conversation transcript:

${[
  '[Assistant thinking] TH\nassistant: AC [tool calls: grep({"p":1}); read({})]',
  'assistant:  [tool calls: x(y)]',
  'assistant: [Assistant thinking] CTH\nassistant: CC',
  `tool: ${'d'.repeat(2000)} …(+1 chars truncated)`,
  `tool: ${longE}`,
  'tool: small',
  'assistant: ',
].join('\n')}`);
  });

  it('placeholder pass counts as success exactly at the trigger budget (total === trigger)', async () => {
    const llm = makeLLM(ok('should not run'));
    const oldTool = 'x'.repeat(12);
    const placeholderContent = `${MICROCOMPACT_MARKER} — 12 chars]`;
    const messages: Message[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'r', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: oldTool },
      { role: 'assistant', content: 'a3' },
    ];
    // user 8+1=9, assistant 8+1+1=10, placeholder 8+est(ph), last 8+1=9.
    const total = 9 + 10 + (8 + est(placeholderContent)) + 9;
    const compactor = new Compactor(llm, model, {
      keepRecentTokens: 1,
      countTokens: est,
      triggerTokens: total,
    });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('placeholder');
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('an error chunk discards text already accumulated and fails the whole summary', async () => {
    const llm = makeLLM([{ type: 'text_delta', content: 'partial ' }, { type: 'error', error: 'upstream died' } as StreamChunk]);
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    expect(await compactor.compact(messages)).toBeNull();
  });

  it('summary is trimmed before assembly into the replacement message', async () => {
    const llm = makeLLM(ok('   spaced summary \n '));
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    const result = await compactor.compact(messages);
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toBe(`${SUMMARY_MARKER}\nspaced summary`);
  });

  it('whitespace-only summary output is treated as failure (null), not an empty compaction', async () => {
    const llm = makeLLM(ok('   \n  '));
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    expect(await compactor.compact(messages)).toBeNull();
  });

  it('chat options are exactly { model } — no stray request fields on the summarization call', async () => {
    const llm = makeLLM(ok());
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'old reply here' },
      { role: 'assistant', content: 'new' },
    ];
    const compactor = new Compactor(llm, model, { keepRecentTokens: 1, countTokens: est });
    await compactor.compact(messages);
    expect(llm.chatCalls).toHaveLength(1);
    expect(llm.chatCalls[0].opts).toEqual({ model });
  });
});
