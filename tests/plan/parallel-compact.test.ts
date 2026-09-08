import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { SUMMARY_MARKER } from '../../src/agent/compaction.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool } from '../../src/tools/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

function makeTool(name: string, delayMs = 0): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (params) => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return { content: `${name}:${String(params.text)}` };
    },
  };
}

function toolCallChunks(id: string, name: string, text: string): StreamChunk[] {
  return [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_delta', id, arguments: JSON.stringify({ text }) },
    { type: 'tool_call_end', id },
  ];
}

describe('AgentLoop parallel tool execution', () => {
  it('executes multiple tool calls of a round concurrently', async () => {
    // toolA returns fast, toolB is slow; if executed sequentially the total
    // wall time would exceed the slow tool alone.
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a', 0));
    registry.register(makeTool('tool_b', 120));

    let callIndex = 0;
    const secondRoundMsgs: Message[] = [];
    const llm: LLMProvider = {
      async *chat(msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (callIndex++ === 0) {
          return yield* toolCallChunks('c1', 'tool_a', 'one')
            .concat(toolCallChunks('c2', 'tool_b', 'two'))
            .values() as Generator<StreamChunk>;
        }
        secondRoundMsgs.push(...msgs);
        yield { type: 'text_delta', content: 'both done' };
      },
    };

    const toolResults: Array<{ id?: string; content: string }> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: (result, callId) => toolResults.push({ id: callId, content: result.content }),
      onPermissionRequest: async () => true,
    });

    const started = Date.now();
    const turn = await loop.processUserInput('run both tools');
    const elapsed = Date.now() - started;

    expect(turn.text).toBe('both done');
    // Both results fed back with their call ids (order not guaranteed)
    expect(toolResults.map((r) => r.id).sort()).toEqual(['c1', 'c2']);
    expect(toolResults.map((r) => r.content).sort()).toEqual(['tool_a:one', 'tool_b:two']);

    // Conversation keeps deterministic order: c1's result before c2's
    const toolMsgs = secondRoundMsgs.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => ('tool_call_id' in m ? m.tool_call_id : ''))).toEqual(['c1', 'c2']);

    // Concurrency: total time close to the slow tool, not the sum
    expect(elapsed).toBeLessThan(220);
  });

  it('still executes a single tool call correctly', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('tool_a'));

    let callIndex = 0;
    const llm: LLMProvider = {
      async *chat(msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (callIndex++ === 0) {
          return yield* toolCallChunks('c1', 'tool_a', 'solo').values() as Generator<StreamChunk>;
        }
        const toolMsgs = msgs.filter((m) => m.role === 'tool');
        expect(toolMsgs).toHaveLength(1);
        yield { type: 'text_delta', content: 'solo done' };
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

    const turn = await loop.processUserInput('run one tool');
    expect(turn.text).toBe('solo done');
  });
});

describe('AgentLoop.compactNow', () => {
  function longText(): string {
    return 'hello '.repeat(200);
  }

  it('forces compaction regardless of the trigger threshold', async () => {
    let replyIndex = 0;
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.tools === undefined) {
          yield { type: 'text_delta', content: 'summary of everything' };
          return;
        }
        // First turn replies long (realistic tool-heavy turn) so that
        // summarizing it shrinks the context.
        yield { type: 'text_delta', content: replyIndex++ === 0 ? 'reply '.repeat(200) : 'ok' };
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 100_000, strategy: 'compact', keepRecentTokens: 0 }, // never auto-triggers; manual /compact forces it
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput(longText());
    await loop.processUserInput(longText());

    const before = loop.getMessages().length;
    const result = await loop.compactNow();

    expect(result.compacted).toBe(true);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens!);
    // History replaced by summary + kept messages (summary replaces the
    // summarized ones 1:1, so the count stays equal — tokens must shrink)
    const after = loop.getMessages();
    expect(after[0].role).toBe('system');
    expect(after[0].content).toContain(SUMMARY_MARKER);
    expect(after.length).toBe(before);
  });

  it('falls back to truncation when strategy is truncate', async () => {
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
      context: { maxTokens: 150, strategy: 'truncate' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    // ~100 tokens per message: auto-truncation keeps history just under 150,
    // manual compact targets triggerTokens/2 = 60 and must drop more
    const medium = 'word '.repeat(100);
    await loop.processUserInput(medium);
    await loop.processUserInput(medium);
    await loop.processUserInput(medium);

    const result = await loop.compactNow();
    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe('truncate');
    expect(loop.getMessages().length).toBeLessThan(4);
  });

  it('falls back to truncation when the /compact summary fails', async () => {
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        if (opts.tools === undefined) {
          yield { type: 'error', error: 'summarizer unavailable' };
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
      context: { maxTokens: 150, strategy: 'compact', keepRecentTokens: 0 },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    const medium = 'word '.repeat(100);
    await loop.processUserInput(medium);
    await loop.processUserInput(medium);

    const result = await loop.compactNow();
    // Summary failed → degraded to aggressive truncate (triggerTokens/2 = 37,
    // far below each ~100-token message), still compacted
    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe('compact'); // strategy config, degraded internally
    expect(loop.getMessages().length).toBeLessThan(4);
  });

  it('returns compacted=false when no context management is configured', async () => {
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

    await loop.processUserInput('hi');
    expect((await loop.compactNow()).compacted).toBe(false);
  });
});
