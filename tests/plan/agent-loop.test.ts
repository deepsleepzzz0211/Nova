import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

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
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => false, // deny
    });

    await loop.processUserInput('use echo');
    // Should not crash, LLM sees denial message
  });
});
