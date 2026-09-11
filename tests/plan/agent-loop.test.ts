import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { SessionStore } from '../../src/agent/session.js';
import type { Tool } from '../../src/tools/types.js';
import { SUMMARY_MARKER } from '../../src/agent/compaction.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

function mockLLM(responses: StreamChunk[][]): LLMProvider {
  let i = 0;
  return {
    async *chat(_msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
      for (const chunk of responses[i++] ?? []) {
        yield chunk;
      }
    },
  };
}

function echoTool(): Tool {
  return {
    name: 'echo',
    description: 'Echo input',
    permission: { mode: 'auto' as const },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (params) => ({ content: `echo: ${params.text}` }),
  };
}

describe('AgentLoop', () => {
  it('streams text response to onToken callback', async () => {
    const llm = mockLLM([[{ type: 'text_delta', content: 'Hello' }, { type: 'text_delta', content: ' world' }]]);
    const registry = new ToolRegistry();
    const tokens: string[] = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: (t) => tokens.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('hi');
    expect(tokens.join('')).toBe('Hello world');
  });

  it('executes tool call and feeds result back to LLM', async () => {
    const llm = mockLLM([
      // First call: LLM wants to call echo tool
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', arguments: '{"text":"hi"}' },
        { type: 'tool_call_end', id: 'c1' },
      ],
      // Second call: LLM returns text after seeing tool result
      [{ type: 'text_delta', content: 'Tool said: echo: hi' }],
    ]);

    const registry = new ToolRegistry();
    registry.register(echoTool());
    const toolCalls: string[] = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: (c) => toolCalls.push(c.function.name),
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('use echo');
    expect(toolCalls).toEqual(['echo']);
  });

  it('respects max tool rounds', async () => {
    // LLM keeps calling tools forever
    const infiniteToolCall: StreamChunk[] = [
      { type: 'tool_call_start', id: 'c1', name: 'echo' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"text":"loop"}' },
      { type: 'tool_call_end', id: 'c1' },
    ];
    let callCount = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        callCount++;
        for (const c of infiniteToolCall) yield c;
      },
    };

    const registry = new ToolRegistry();
    registry.register(echoTool());

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 3, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('loop');
    expect(callCount).toBeLessThanOrEqual(4); // 3 rounds + 1 final
  });

  it('skips tool execution when permission denied', async () => {
    const llm = mockLLM([
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', arguments: '{"text":"secret"}' },
        { type: 'tool_call_end', id: 'c1' },
      ],
      [{ type: 'text_delta', content: 'Permission denied' }],
    ]);

    const registry = new ToolRegistry();
    registry.register(echoTool());

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => false, // deny
    });

    await loop.processUserInput('use echo');
    // Should not crash, LLM sees denial message
  });

  it('reports stream errors through onToken and stops the turn', async () => {
    const llm = mockLLM([[{ type: 'error', error: 'boom from provider' }]]);
    const tokens: string[] = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: (t) => tokens.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('hi');
    expect(tokens.join('')).toBe('[Error: boom from provider]');
  });

  it('reports unknown tools as error tool results with is_error', async () => {
    const llm = mockLLM([
      [
        { type: 'tool_call_start', id: 'c1', name: 'does_not_exist' },
        { type: 'tool_call_delta', id: 'c1', arguments: '{}' },
        { type: 'tool_call_end', id: 'c1' },
      ],
      [{ type: 'text_delta', content: 'ok' }],
    ]);

    const results: Array<{ content: string; isError?: boolean }> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: (r) => results.push(r),
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('use ghost tool');
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('not found');
    expect(results[0].content).toContain('does_not_exist');
  });

  it('loadMessages seeds history exactly (resume support)', async () => {
    const llm = mockLLM([[{ type: 'text_delta', content: 'ok' }]]);
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const history: Message[] = [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: 'answer' },
    ];
    loop.loadMessages(history);
    expect(loop.getMessages()).toEqual(history);
  });
});

describe('AgentLoop.undoTurns', () => {
  function makeTool(name: string): Tool {
    return {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (params) => ({ content: `${name}:${String(params.text)}` }),
    };
  }

  function toolCallChunks(id: string, name: string, text: string): StreamChunk[] {
    return [
      { type: 'tool_call_start', id, name },
      { type: 'tool_call_delta', id, arguments: JSON.stringify({ text }) },
      { type: 'tool_call_end', id },
    ];
  }

  function makeToolTurnLoop(): { loop: AgentLoop; llm: LLMProvider } {
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.tools === undefined) {
          yield { type: 'text_delta', content: 'summary' };
          return;
        }
        yield { type: 'text_delta', content: 'ok' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    return { loop, llm };
  }

  it('undoes the last turn (user + assistant replies) by default', async () => {
    const { loop } = makeToolTurnLoop();
    await loop.processUserInput('turn one');
    await loop.processUserInput('turn two');

    const result = loop.undoTurns();
    expect(result.undone).toBe(true);
    expect(result.undoneTurns).toBe(1);
    const msgs = loop.getMessages();
    expect(msgs.some((m) => m.role === 'user' && m.content === 'turn two')).toBe(false);
    expect(msgs.some((m) => m.role === 'user' && m.content === 'turn one')).toBe(true);
  });

  it('undoes N turns and clamps to the conversation start', async () => {
    const { loop } = makeToolTurnLoop();
    await loop.processUserInput('one');
    await loop.processUserInput('two');
    await loop.processUserInput('three');

    const two = loop.undoTurns(2);
    expect(two.undoneTurns).toBe(2);
    expect(loop.getMessages().some((m) => m.role === 'user' && m.content === 'three')).toBe(false);
    expect(loop.getMessages().some((m) => m.role === 'user' && m.content === 'one')).toBe(true);

    const clamped = loop.undoTurns(99);
    expect(clamped.undone).toBe(true);
    expect(clamped.undoneTurns).toBe(1); // only 'one' remained
    expect(loop.getMessages().filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('keeps tool call/result pairs intact across the cut', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a'));
    let callIndex = 0;
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.tools === undefined) {
          yield { type: 'text_delta', content: 'summary' };
          return;
        }
        if (callIndex++ === 0) {
          return yield* toolCallChunks('c1', 'tool_a', 'x').values() as Generator<StreamChunk>;
        }
        yield { type: 'text_delta', content: 'done' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('run the tool');
    const result = loop.undoTurns();
    expect(result.undone).toBe(true);
    const msgs = loop.getMessages();
    // No orphan tool results / dangling tool_calls after the cut
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(msgs.filter((m) => m.role === 'assistant' && 'tool_calls' in m)).toHaveLength(0);
  });

  it('persists the post-undo state for --resume replay', async () => {
    const { loop } = makeToolTurnLoop();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-undo-'));
    try {
      const sessionFile = path.join(dir, 's.jsonl');
      const store = new SessionStore(sessionFile);
      const llm2: LLMProvider = {
        async *chat(): AsyncIterable<StreamChunk> {
          yield { type: 'text_delta', content: 'ok' };
        },
      };
      const loop2 = new AgentLoop({
        llm: llm2,
        toolRegistry: new ToolRegistry(),
        toolExecutionPipeline: makePipeline(),
        session: store,
        config: { maxToolRounds: 10, model: 'test' },
        onToken: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onPermissionRequest: async () => true,
      });
      await loop2.processUserInput('one');
      await loop2.processUserInput('two');
      loop2.undoTurns(1);
      await store.close();

      const replayed = SessionStore.load(sessionFile);
      expect(replayed.some((m) => m.role === 'user' && m.content === 'two')).toBe(false);
      expect(replayed.some((m) => m.role === 'user' && m.content === 'one')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    void loop;
  });

  it('returns undone=false when there is no user turn to undo', () => {
    const { loop } = makeToolTurnLoop();
    const result = loop.undoTurns();
    expect(result.undone).toBe(false);
    expect(result.undoneTurns).toBe(0);
  });
});

describe('AgentLoop truncation continuation + empty stream (streaming ticket 05)', () => {
  it('continues after a truncated stream without duplicating the user message', async () => {
    const chatMessages: Message[][] = [];
    let chatCall = 0;
    const llm: LLMProvider = {
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        chatMessages.push(msgs.map((m) => ({ ...m })));
        chatCall++;
        if (chatCall === 1) {
          yield { type: 'text_delta', content: 'partial an' };
          yield { type: 'truncated' };
          return;
        }
        yield { type: 'text_delta', content: 'swer' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const turn = await loop.processUserInput('question');
    expect(turn.text).toBe('partial answer');
    // Continuation request: original user message once, partial assistant
    // message (with its content), then the continuation instruction.
    const cont = chatMessages[1];
    expect(cont.filter((m) => m.role === 'user' && m.content === 'question')).toHaveLength(1);
    expect(cont.some((m) => m.role === 'assistant' && m.content === 'partial an')).toBe(true);
    const contMsg = cont.at(-1);
    expect(contMsg?.role).toBe('user');
    expect((contMsg as { content: string }).content).toMatch(/Continue exactly where you stopped/);
    // History keeps exactly one continuation user message
    const history = loop.getMessages();
    expect(history.filter((m) => m.role === 'user' && m.content === contMsg?.content)).toHaveLength(1);
  });

  it('keeps thinking on the partial assistant message across a continuation', async () => {
    let chatCall = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        chatCall++;
        if (chatCall === 1) {
          yield { type: 'thinking_delta', content: 'reasoned' };
          yield { type: 'text_delta', content: 'part' };
          yield { type: 'truncated' };
          return;
        }
        yield { type: 'text_delta', content: 'ial' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    await loop.processUserInput('q');
    const partial = loop.getMessages().find((m) => m.role === 'assistant');
    expect((partial as { thinking?: string }).thinking).toBe('reasoned');
    expect(partial?.content).toBe('part');
  });

  it('retries an empty stream once and succeeds', async () => {
    let chatCall = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        chatCall++;
        if (chatCall === 1) return; // empty stream
        yield { type: 'text_delta', content: 'recovered' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    const turn = await loop.processUserInput('q');
    expect(turn.text).toBe('recovered');
    expect(chatCall).toBe(2);
  });

  it('errors cleanly after a second empty stream', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        return; // always empty
      },
    };
    const tokens: string[] = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: (t) => tokens.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    const turn = await loop.processUserInput('q');
    expect(turn.text).toBe('');
    expect(tokens.join('')).toBe('[Error: LLM returned an empty stream]');
  });
});

describe('AgentLoop pending tool visibility (streaming ticket 04)', () => {
  function makeTool(name: string): Tool {
    return {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (params) => ({ content: `${name}:${String(params.text)}` }),
    };
  }

  it('surfaces tool_call_start immediately and fires onToolCall exactly once', async () => {
    const callsSeen: Array<{ id: string; args: string }> = [];
    let release: (() => void) | undefined;
    let sawStart = false;
    let chatCall = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        chatCall++;
        if (chatCall > 1) {
          // Second round (after tool execution): finish the turn.
          yield { type: 'text_delta', content: 'done' };
          return;
        }
        yield { type: 'tool_call_start', id: 't1', name: 'bash' };
        sawStart = true;
        yield { type: 'tool_call_delta', id: 't1', arguments: '{"text' };
        yield { type: 'tool_call_delta', id: 't1', arguments: '":"hi"}' };
        // Hold the stream open so the UI has the pending call before execution
        await new Promise<void>((r) => { release = r; });
        yield { type: 'text_delta', content: 'round 1 tail' };
      },
    };
    let executed = false;
    const trackingTool: Tool = {
      name: 'bash',
      description: 'Tool bash',
      permission: { mode: 'auto' as const },
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async () => {
        executed = true;
        return { content: 'ran bash' };
      },
    };
    const registry = new ToolRegistry();
    registry.register(trackingTool);
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: (call) => callsSeen.push({ id: call.id, args: call.function.arguments }),
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const turnPromise = loop.processUserInput('use the tool');
    // Wait until the generator is parked on the hold promise, so release is
    // assigned; while parked, the call is already surfaced (pending).
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sawStart).toBe(true);
    expect(callsSeen).toEqual([{ id: 't1', args: '' }]); // surfaced mid-stream
    release?.();
    const turn = await turnPromise;
    expect(callsSeen).toEqual([{ id: 't1', args: '' }]); // exactly once, not re-fired
    expect(executed).toBe(true);
    void turn;
  });
});

describe('AgentLoop thinking channel (streaming ticket 03)', () => {
  it('forwards thinking deltas and stores thinking on the assistant message', async () => {
    const thinkingSeen: string[] = [];
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'thinking_delta', content: 'let me ' };
        yield { type: 'thinking_delta', content: 'think' };
        yield { type: 'text_delta', content: 'final answer' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onThinking: (d) => thinkingSeen.push(d),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const turn = await loop.processUserInput('question');
    expect(turn.text).toBe('final answer');
    expect(thinkingSeen.join('')).toBe('let me think');
    const assistant = loop.getMessages().find((m) => m.role === 'assistant');
    expect((assistant as { thinking?: string }).thinking).toBe('let me think');
    expect(assistant?.content).toBe('final answer');
  });

  it('interrupt keeps the partial thinking alongside partial text', async () => {
    let release: (() => void) | undefined;
    let sawThinking = false;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'thinking_delta', content: 'partial thought' };
        sawThinking = true;
        await new Promise<void>((r) => { release = r; });
        yield { type: 'text_delta', content: 'never' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    const turnPromise = loop.processUserInput('q');
    const timer = setInterval(() => {
      if (sawThinking) {
        clearInterval(timer);
        loop.interrupt();
      }
    }, 5);
    await turnPromise;
    const assistant = loop.getMessages().find((m) => m.role === 'assistant');
    expect((assistant as { thinking?: string }).thinking).toBe('partial thought');
    release?.();
    void timer;
  });
});

describe('AgentLoop.interrupt (streaming ticket 02)', () => {
  function makeTool(name: string): Tool {
    return {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: async (params) => ({ content: `${name}:${String(params.text)}` }),
    };
  }

  it('keeps partial text and discards tool-call half-frames on interrupt', async () => {
    const toolCallsSeen: string[] = [];
    let sawPartial = false;
    let release: (() => void) | undefined;
    const llm: LLMProvider = {
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        // Emit partial text, then a half tool-call frame, then hang.
        yield { type: 'text_delta', content: 'par' };
        sawPartial = true;
        yield { type: 'tool_call_start', id: 'c1', name: 'bash' };
        yield { type: 'tool_call_delta', id: 'c1', arguments: '{"co' };
        await new Promise<void>((r) => { release = r; }); // hang until released
        yield { type: 'text_delta', content: ' never' };
      },
    };
    const registry = new ToolRegistry();
    registry.register(makeTool('bash'));
    const onToolResult: Array<unknown> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: (call) => toolCallsSeen.push(call.id),
      onToolResult: (r) => onToolResult.push(r),
      onPermissionRequest: async () => true,
    });

    const turnPromise = loop.processUserInput('long running');
    // Wait until the partial text has been consumed, then interrupt.
    const waitPartial = setInterval(() => {
      if (sawPartial) {
        clearInterval(waitPartial);
        loop.interrupt();
      }
    }, 5);
    const turn = await turnPromise;

    expect(turn.text).toBe('par');
    // Ticket 04: the half-frame IS surfaced mid-stream as a pending call,
    // then marked interrupted in the UI — but never executed.
    expect(toolCallsSeen).toEqual(['c1']);
    expect(onToolResult).toHaveLength(1);
    expect((onToolResult[0] as { isError?: boolean }).isError).toBe(true);
    const msgs = loop.getMessages();
    expect(msgs.some((m) => m.role === 'assistant' && m.content === 'par')).toBe(true);
    expect(msgs.some((m) => m.role === 'tool')).toBe(false); // never executed
    release?.(); // unblock the generator so the test can end cleanly
    void waitPartial;
  });

  it('interrupt with no in-flight stream is a no-op', () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'ok' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    expect(() => loop.interrupt()).not.toThrow();
  });
});

describe('AgentLoop context management', () => {
  function longText(): string {
    return 'hello '.repeat(200); // ~ 200+ tokens with tiktoken
  }

  it('compacts context before calling the LLM when near the limit', async () => {
    const calls: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
    let callIndex = 0;
    const llm: LLMProvider = {
      async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        calls.push({ msgs: [...msgs], opts });
        callIndex++;
        // Compaction request (no tools) → summary text
        if (opts.tools === undefined) {
          yield { type: 'text_delta', content: 'User tested context compaction.' };
          return;
        }
        // First turn replies long (like a real tool-heavy turn) so that
        // summarizing it actually shrinks the context.
        yield { type: 'text_delta', content: callIndex === 1 ? 'reply '.repeat(200) : 'done' };
      },
    };

    const registry = new ToolRegistry();
    const compactions: Array<{ strategy: string; beforeTokens: number; afterTokens: number }> = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 150, strategy: 'compact', keepRecentTokens: 0 },
      onCompaction: (info) => compactions.push(info),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    // Two long turns force the second turn over the trigger
    await loop.processUserInput(longText());
    await loop.processUserInput(longText());

    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0].strategy).toBe('compact');
    expect(compactions[0].afterTokens).toBeLessThan(compactions[0].beforeTokens);

    // The LLM must have received a summary message
    const sawSummary = calls.some((c) => c.msgs[0]?.role === 'system' && c.msgs[0].content.startsWith(SUMMARY_MARKER));
    expect(sawSummary).toBe(true);
  });

  it('falls back to truncation when the compaction summary fails', async () => {
    // Summary requests (tools === undefined) always fail → the loop must
    // degrade to truncate instead of fail-open (which would hit the
    // context window on the next round).
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.tools === undefined) {
          yield { type: 'error', error: 'summarizer unavailable' };
          return;
        }
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const registry = new ToolRegistry();
    const compactions: Array<{ strategy: string; beforeTokens: number; afterTokens: number }> = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 150, strategy: 'compact', keepRecentTokens: 0 },
      onCompaction: (info) => compactions.push(info),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput(longText());
    await loop.processUserInput(longText());

    // Degraded compaction still shrank the context — via truncation
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0].strategy).toBe('truncate');
    expect(compactions[0].afterTokens).toBeLessThan(compactions[0].beforeTokens);
  });

  it('reactively compacts and retries once when the API reports context overflow', async () => {
    // The estimate says the context fits (no proactive compaction fires),
    // but the provider still rejects it — the reactive safety net must
    // compact and retry the round exactly once.
    let chatCalls = 0;
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        // Summarizer calls (tool-free) always succeed
        if (opts.tools === undefined) {
          yield { type: 'text_delta', content: 'User tested overflow recovery.' };
          return;
        }
        chatCalls++;
        if (chatCalls === 1) {
          yield { type: 'text_delta', content: 'reply '.repeat(200) }; // big turn-1 reply
          return;
        }
        if (chatCalls === 2) {
          throw new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens. Please reduce the length of the messages.");
        }
        yield { type: 'text_delta', content: 'recovered' };
      },
    };

    const compactions: Array<{ strategy: string }> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      // High trigger (no proactive compaction) but the provider overflows anyway
      context: { maxTokens: 1000, strategy: 'compact', keepRecentTokens: 0 },
      onCompaction: (info) => compactions.push(info),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('hello '.repeat(15));
    const turn = await loop.processUserInput('hello '.repeat(15));

    expect(turn.text).toBe('recovered');
    expect(chatCalls).toBe(3); // turn1 + overflow + one retry
    expect(compactions.some((c) => c.strategy === 'compact')).toBe(true);
  });

  it('gives up cleanly when the retry still overflows (no compaction loop)', async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        callCount++;
        throw new Error('maximum context length exceeded');
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 150, strategy: 'compact', keepRecentTokens: 0 },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput(longText());
    const turn = await loop.processUserInput(longText());

    expect(callCount).toBe(2); // original + single retry, then clean failure
    expect(turn.text).toBe('');
  });

  it('does not retry on ordinary errors', async () => {
    let callCount = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        callCount++;
        throw new Error('connection refused');
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 150, strategy: 'compact', keepRecentTokens: 0 },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const turn = await loop.processUserInput(longText());
    expect(callCount).toBe(1);
    expect(turn.text).toBe('');
  });

  it('truncates context when strategy is truncate', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const registry = new ToolRegistry();
    const compactions: Array<{ strategy: string }> = [];

    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 150, strategy: 'truncate' },
      onCompaction: (info) => compactions.push(info),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput(longText());
    await loop.processUserInput(longText());

    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0].strategy).toBe('truncate');
  });

  it('persists every message to the session store', async () => {
    const llm = mockLLM([
      [
        { type: 'tool_call_start', id: 'c1', name: 'echo' },
        { type: 'tool_call_delta', id: 'c1', arguments: '{"text":"hi"}' },
        { type: 'tool_call_end', id: 'c1' },
      ],
      [{ type: 'text_delta', content: 'done' }],
    ]);

    const registry = new ToolRegistry();
    registry.register(echoTool());

    const store = new MemorySessionStore();
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      session: store,
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('use echo');

    const roles = store.entries.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});

/** In-memory SessionStore double for tests. */
import type { Message as Message2 } from '../../src/llm/types.js';
class MemorySessionStore {
  readonly entries: Message2[] = [];
  async append(message: Message2): Promise<void> {
    this.entries.push(message);
  }
  async close(): Promise<void> {}
}

describe('AgentLoop context reporting (ticket 22)', () => {
  it('reports the real context size and trigger budget after a turn', async () => {
    const seen: Array<{ tokens: number; trigger: number }> = [];
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'ok' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 10_000, reserveTokens: 2_000, keepRecentTokens: 1_000, strategy: 'truncate' },
      onContextSize: (tokens, trigger) => seen.push({ tokens, trigger }),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('hello');
    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    // A real count of the conversation, and the reserve-adjusted trigger.
    expect(last.tokens).toBeGreaterThan(0);
    expect(last.trigger).toBe(8_000);
  });
});
