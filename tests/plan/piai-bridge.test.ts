import { describe, it, expect } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall as PiaiToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import type { Message, StreamChunk, ToolDefinition } from '../../src/llm/types.js';
import {
  toPiaiContext,
  toPiaiMessages,
  toPiaiTools,
  createPiaiChunkTranslator,
  toNovaChunks,
} from '../../src/llm/piai-bridge.js';

/**
 * Ticket 02 — Nova ↔ pi-ai pure bridge (no network):
 *  - Nova Message[] (+ systemPrompt + ToolDefinition[]) → pi-ai Context
 *  - Nova ToolDefinition (JSON Schema) → pi-ai Tool (TypeBox parameters)
 *  - pi-ai AssistantMessageEvent stream → Nova StreamChunk stream
 */

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function partial(content: AssistantMessage['content'] = []): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o',
    usage: emptyUsage(),
    stopReason: 'pending',
    timestamp: 0,
  };
}

describe('toPiaiContext: system prompt handling', () => {
  it('uses the systemPrompt option when history has no system message', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const ctx = toPiaiContext({ messages, systemPrompt: 'You are Nova.' });

    expect(ctx.systemPrompt).toBe('You are Nova.');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.role).toBe('user');
  });

  it('lets a leading system message in history override the option (withSystemPrompt semantics)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'from history' },
      { role: 'user', content: 'hi' },
    ];
    const ctx = toPiaiContext({ messages, systemPrompt: 'option prompt' });

    expect(ctx.systemPrompt).toBe('from history');
    expect(ctx.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('converts mid-history system messages to user "[context]" messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'injected skill' },
      { role: 'user', content: 'go on' },
    ];
    const ctx = toPiaiContext({ messages });

    expect(ctx.systemPrompt).toBeUndefined();
    expect(ctx.messages[1]!.role).toBe('user');
    const mid = ctx.messages[1] as { content: string };
    expect(mid.content).toBe('[context] injected skill');
  });

  it('carries tools through to the context', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];
    const ctx = toPiaiContext({ messages: [], tools });

    expect(ctx.tools).toHaveLength(1);
    expect(ctx.tools![0]!.name).toBe('read_file');
  });

  it('omits the tools field for an empty tool list', () => {
    const ctx = toPiaiContext({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(ctx.tools).toBeUndefined();
  });
});

describe('toPiaiMessages: Nova → pi-ai message shapes', () => {
  it('maps a plain user message', () => {
    const [msg] = toPiaiMessages([{ role: 'user', content: 'hello' }]);
    expect(msg!.role).toBe('user');
    expect((msg as { content: string }).content).toBe('hello');
    expect(typeof msg!.timestamp).toBe('number');
  });

  it('maps assistant thinking + text + tool calls to typed content blocks', () => {
    const [msg] = toPiaiMessages([
      {
        role: 'assistant',
        content: 'The answer is 42.',
        thinking: 'let me think',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
    ]);

    expect(msg!.role).toBe('assistant');
    const assistant = msg as AssistantMessage;
    const kinds = assistant.content.map((b) => b.type);
    expect(kinds).toEqual(['thinking', 'text', 'toolCall']);

    const [thinking, text, tool] = assistant.content;
    expect((thinking as { thinking: string }).thinking).toBe('let me think');
    expect((text as { text: string }).text).toBe('The answer is 42.');
    const call = tool as PiaiToolCall;
    expect(call.id).toBe('call_1');
    expect(call.name).toBe('bash');
    expect(call.arguments).toEqual({ cmd: 'ls' });

    // Replayed assistant history must report toolUse as its stop reason
    expect(assistant.stopReason).toBe('toolUse');
  });

  it('maps assistant with null content and only tool calls', () => {
    const [msg] = toPiaiMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'grep', arguments: '' } },
        ],
      },
    ]);
    const assistant = msg as AssistantMessage;
    expect(assistant.content).toHaveLength(1);
    const call = assistant.content[0] as PiaiToolCall;
    expect(call.type).toBe('toolCall');
    expect(call.arguments).toEqual({});
  });

  it('maps tool results with the tool name resolved from the preceding assistant call', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_9', content: 'file body', is_error: true },
    ];
    const [, result] = toPiaiMessages(messages);

    expect(result!.role).toBe('toolResult');
    const toolResult = result as {
      toolCallId: string;
      toolName: string;
      content: { type: string; text: string }[];
      isError: boolean;
    };
    expect(toolResult.toolCallId).toBe('call_9');
    expect(toolResult.toolName).toBe('read_file');
    expect(toolResult.content).toEqual([{ type: 'text', text: 'file body' }]);
    expect(toolResult.isError).toBe(true);
  });

  it('defaults tool result isError to false and unknown ids keep a resolvable name', () => {
    const [msg] = toPiaiMessages([
      { role: 'tool', tool_call_id: 'orphan', content: 'ok' },
    ]);
    const toolResult = msg as { toolName: string; isError: boolean };
    expect(toolResult.toolName).toBe('orphan');
    expect(toolResult.isError).toBe(false);
  });

  it('gives each converted assistant message its own usage object', () => {
    const [a, b] = toPiaiMessages([
      { role: 'assistant', content: 'one' },
      { role: 'assistant', content: 'two' },
    ]) as [AssistantMessage, AssistantMessage];
    expect(a.usage).not.toBe(b.usage);
    a.usage.input = 99;
    expect(b.usage.input).toBe(0);
  });

  it('rejects non-JSON tool call arguments loudly instead of silently dropping them', () => {
    expect(() =>
      toPiaiMessages([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'x', type: 'function', function: { name: 't', arguments: '{not json' } },
          ],
        },
      ]),
    ).toThrow(/tool call "t"/);
  });
});

describe('toPiaiTools: JSON Schema → TypeBox', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path' },
      line: { type: 'number' },
    },
    required: ['path'],
  };
  const defs: ToolDefinition[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: schema } },
  ];

  it('produces pi-ai Tools carrying name/description', () => {
    const [tool] = toPiaiTools(defs);
    expect(tool!.name).toBe('read_file');
    expect(tool!.description).toBe('Read a file');
  });

  it('keeps the JSON Schema intact for the model request payload', () => {
    const [tool] = toPiaiTools(defs);
    const serialized = JSON.parse(JSON.stringify(tool!.parameters));
    expect(serialized).toMatchObject(schema);
  });

  it('validates tool-call arguments through pi-ai execution path', () => {
    const [tool] = toPiaiTools(defs);
    const call = (args: Record<string, unknown>): PiaiToolCall => ({
      type: 'toolCall',
      id: 'call_1',
      name: 'read_file',
      arguments: args,
    });

    expect(validateToolArguments(tool!, call({ path: 'a.txt', line: 3 }))).toMatchObject({ path: 'a.txt' });
    expect(() => validateToolArguments(tool!, call({ line: 3 }))).toThrow();
  });
});

describe('chunk translator: pi-ai events → Nova StreamChunk', () => {
  const translate = (...events: AssistantMessageEvent[]): StreamChunk[] => {
    const t = createPiaiChunkTranslator();
    return events.flatMap((e) => t(e));
  };

  it('maps text and thinking deltas', () => {
    const chunks = translate(
      { type: 'start', partial: partial() },
      { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: partial() },
      { type: 'thinking_delta', contentIndex: 1, delta: 'hm', partial: partial() },
      { type: 'text_end', contentIndex: 0, content: 'Hel', partial: partial() },
    );
    expect(chunks).toEqual([
      { type: 'text_delta', content: 'Hel' },
      { type: 'thinking_delta', content: 'hm' },
    ]);
  });

  it('maps a full tool call lifecycle (start → deltas → end)', () => {
    const tcPartial = partial([{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }]);
    const doneMsg = {
      ...partial([{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } }]),
      stopReason: 'toolUse' as const,
    };
    const chunks = translate(
      { type: 'start', partial: tcPartial },
      { type: 'toolcall_start', contentIndex: 0, partial: tcPartial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"cmd":', partial: tcPartial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '"ls"}', partial: tcPartial },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } },
        partial: tcPartial,
      },
      { type: 'done', reason: 'toolUse', message: doneMsg },
    );

    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'call_1', name: 'bash' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '{"cmd":' },
      { type: 'tool_call_delta', id: 'call_1', arguments: '"ls"}' },
      { type: 'tool_call_end', id: 'call_1' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it('tracks concurrent tool calls by content index', () => {
    const two = partial([
      { type: 'toolCall', id: 'a', name: 'one', arguments: {} },
      { type: 'toolCall', id: 'b', name: 'two', arguments: {} },
    ]);
    const chunks = translate(
      { type: 'toolcall_start', contentIndex: 0, partial: two },
      { type: 'toolcall_start', contentIndex: 1, partial: two },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{}', partial: two },
      {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: { type: 'toolCall', id: 'b', name: 'two', arguments: {} },
        partial: two,
      },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'a', name: 'one', arguments: {} },
        partial: two,
      },
    );
    expect(chunks.map((c) => `${c.type}:${(c as { id?: string }).id ?? ''}`)).toEqual([
      'tool_call_start:a',
      'tool_call_start:b',
      'tool_call_delta:b',
      'tool_call_end:b',
      'tool_call_end:a',
    ]);
  });

  it('defers tool_call_start until id and name are knowable (late-arriving name)', () => {
    const noName = partial([{ type: 'toolCall', id: 'call_7', name: '', arguments: {} }]);
    const withName = partial([{ type: 'toolCall', id: 'call_7', name: 'fetch', arguments: {} }]);
    const chunks = translate(
      { type: 'toolcall_start', contentIndex: 0, partial: noName },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"u"', partial: withName },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call_7', name: 'fetch', arguments: { u: '' } },
        partial: withName,
      },
    );
    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'call_7', name: 'fetch' },
      { type: 'tool_call_delta', id: 'call_7', arguments: '{"u"' },
      { type: 'tool_call_end', id: 'call_7' },
    ]);
  });

  it('emits usage totals including cache tokens on done', () => {
    const message = {
      ...partial([{ type: 'text', text: 'ok' }]),
      stopReason: 'stop' as const,
      usage: { ...emptyUsage(), input: 100, cacheRead: 30, cacheWrite: 5, output: 12 },
    };
    const chunks = translate({ type: 'done', reason: 'stop', message });
    expect(chunks).toEqual([
      { type: 'usage', inputTokens: 135, outputTokens: 12, cachedInputTokens: 30, cacheWriteTokens: 5 },
    ]);
  });

  it('maps done(reason=length) to a truncated chunk after usage', () => {
    const message = { ...partial(), stopReason: 'length' as const };
    const chunks = translate({ type: 'done', reason: 'length', message });
    expect(chunks.map((c) => c.type)).toEqual(['usage', 'truncated']);
  });

  it('maps error(reason=error) to an error chunk carrying the message', () => {
    const errored = { ...partial(), stopReason: 'error' as const, errorMessage: 'boom' };
    const chunks = translate({ type: 'error', reason: 'error', error: errored });
    expect(chunks).toEqual([{ type: 'error', error: 'boom' }]);
  });

  it('falls back to a generic text when an error event has no message', () => {
    const chunks = translate({ type: 'error', reason: 'error', error: partial() });
    expect(chunks).toEqual([{ type: 'error', error: 'pi-ai stream error' }]);
  });

  it('treats aborted as an error end (same semantics as wire adapters)', () => {
    const aborted = { ...partial(), stopReason: 'aborted' as const };
    const chunks = translate(
      { type: 'text_delta', contentIndex: 0, delta: 'pa', partial: aborted },
      { type: 'error', reason: 'aborted', error: aborted },
    );
    expect(chunks).toEqual([
      { type: 'text_delta', content: 'pa' },
      { type: 'error', error: 'aborted' },
    ]);
  });

  it('carries the provider message when an abort had one', () => {
    const aborted = { ...partial(), stopReason: 'aborted' as const, errorMessage: 'user cancelled' };
    const chunks = translate({ type: 'error', reason: 'aborted', error: aborted });
    expect(chunks).toEqual([{ type: 'error', error: 'user cancelled' }]);
  });

  it('reconstructs the full lifecycle when toolcall_end arrives without a start', () => {
    const tcPartial = partial([{ type: 'toolCall', id: 'ghost', name: 'bash', arguments: { cmd: 'ls' } }]);
    const chunks = translate(
      { type: 'start', partial: tcPartial },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'ghost', name: 'bash', arguments: { cmd: 'ls' } },
        partial: tcPartial,
      },
    );
    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'ghost', name: 'bash' },
      { type: 'tool_call_delta', id: 'ghost', arguments: '{"cmd":"ls"}' },
      { type: 'tool_call_end', id: 'ghost' },
    ]);
  });

  it('buffers argument fragments until an id exists, then flushes in order', () => {
    const noId = partial([{ type: 'toolCall', id: '', name: '', arguments: {} }]);
    const chunks = translate(
      { type: 'toolcall_start', contentIndex: 0, partial: noId },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a"', partial: noId },
      { type: 'toolcall_delta', contentIndex: 0, delta: ':1}', partial: noId },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'late_1', name: 'set', arguments: { a: 1 } },
        partial: noId,
      },
    );
    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'late_1', name: 'set' },
      { type: 'tool_call_delta', id: 'late_1', arguments: '{"a":1}' },
      { type: 'tool_call_end', id: 'late_1' },
    ]);
  });
});

describe('toNovaChunks: async event stream → chunk stream', () => {
  it('flattens an async iterable of pi-ai events into Nova chunks', async () => {
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: 'start', partial: partial() };
      yield { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: partial() };
      yield { type: 'done', reason: 'stop', message: partial() };
    }
    const collected: StreamChunk[] = [];
    for await (const chunk of toNovaChunks(events())) {
      collected.push(chunk);
    }
    expect(collected).toEqual([
      { type: 'text_delta', content: 'hi' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it('keeps tool call state across the whole stream', async () => {
    const tcPartial = partial([{ type: 'toolCall', id: 'z', name: 'edit', arguments: {} }]);
    async function* events(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: 'start', partial: tcPartial };
      yield { type: 'toolcall_start', contentIndex: 0, partial: tcPartial };
      yield { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: tcPartial };
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'z', name: 'edit', arguments: {} },
        partial: tcPartial,
      };
      yield { type: 'done', reason: 'toolUse', message: tcPartial };
    }
    const collected: StreamChunk[] = [];
    for await (const chunk of toNovaChunks(events())) {
      collected.push(chunk);
    }
    expect(collected).toEqual([
      { type: 'tool_call_start', id: 'z', name: 'edit' },
      { type: 'tool_call_delta', id: 'z', arguments: '{}' },
      { type: 'tool_call_end', id: 'z' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
    ]);
  });
});
