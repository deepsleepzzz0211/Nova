import { describe, it, expect } from 'vitest';
import type { Message, ToolCall, StreamChunk } from '../../src/llm/types.js';
import type { Tool, ToolResult, ToolContext } from '../../src/tools/types.js';
import { toToolDefinition } from '../../src/tools/types.js';

describe('LLM Types', () => {
  it('Message covers all roles', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ];
    expect(msgs).toHaveLength(5);
  });

  it('StreamChunk covers all types', () => {
    const chunks: StreamChunk[] = [
      { type: 'text_delta', content: 'hello' },
      { type: 'tool_call_start', id: 'c1', name: 'test' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"a":1}' },
      { type: 'tool_call_end', id: 'c1' },
      { type: 'error', error: 'fail' },
    ];
    expect(chunks).toHaveLength(5);
  });
});

describe('Tool Types', () => {
  it('toToolDefinition converts Tool correctly', () => {
    const tool: Tool = {
      name: 'test_tool',
      description: 'A test',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => ({ content: 'ok' }),
    };
    const def = toToolDefinition(tool);
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('test_tool');
  });

  it('ToolResult supports success and error', () => {
    const ok: ToolResult = { content: 'ok' };
    const err: ToolResult = { content: 'fail', isError: true };
    expect(ok.isError).toBeUndefined();
    expect(err.isError).toBe(true);
  });
});
