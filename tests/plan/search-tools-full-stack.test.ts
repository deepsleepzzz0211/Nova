import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { createGrepTool } from '../../src/tools/grep.js';
import { createGlobTool } from '../../src/tools/glob.js';
import { createListDirTool } from '../../src/tools/list-dir.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

/**
 * Full-stack (no-network) proof for the search batch: a scripted provider
 * emits a real tool_call, and the ACTUAL AgentLoop + ToolExecutionPipeline +
 * grep/glob/list_dir tools (with the embedded ripgrep WASM engine for the
 * first two) run it over the real repository and feed the result back. This
 * exercises transport loop → permission → pipeline → engine → backfill on the
 * same code the built binary ships; it does NOT assert model wording.
 */

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function pipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

function scripted(responses: StreamChunk[][]): LLMProvider {
  let i = 0;
  return {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(_msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
      for (const chunk of responses[i++] ?? []) yield chunk;
    },
  };
}

function toolCall(id: string, name: string, args: string): StreamChunk[] {
  return [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_delta', id, arguments: args },
    { type: 'tool_call_end', id },
  ];
}

function searchRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createGrepTool());
  r.register(createGlobTool());
  r.register(createListDirTool());
  return r;
}

describe('search tools through the full agent loop', () => {
  it('grep: a scripted tool_call runs the real WASM engine and backfills matches', async () => {
    // "runRipgrep" is defined only in src/tools/ripgrep-worker.ts in this repo.
    const llm = scripted([
      toolCall('c1', 'grep', '{"pattern":"export function runRipgrep","output_mode":"content"}'),
      [{ type: 'text_delta', content: 'done' }],
    ]);
    const results: string[] = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: searchRegistry(),
      toolExecutionPipeline: pipeline(),
      config: { maxToolRounds: 5, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: (r) => results.push(r.content),
      onPermissionRequest: async () => true,
    });
    await loop.processUserInput('where is runRipgrep');
    const history = loop.getMessages();
    const toolMsg = history.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = String(toolMsg?.content ?? '');
    expect(content.toLowerCase()).not.toContain('error');
    expect(content).toContain('ripgrep-worker.ts');
  });

  it('glob: a scripted tool_call lists real files through the pipeline', async () => {
    const llm = scripted([
      toolCall('c1', 'glob', '{"pattern":"**/ripgrep-worker.ts"}'),
      [{ type: 'text_delta', content: 'done' }],
    ]);
    const loop = new AgentLoop({
      llm,
      toolRegistry: searchRegistry(),
      toolExecutionPipeline: pipeline(),
      config: { maxToolRounds: 5, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    await loop.processUserInput('find the worker file');
    const toolMsg = loop.getMessages().find((m) => m.role === 'tool');
    expect(String(toolMsg?.content ?? '')).toContain('src/tools/ripgrep-worker.ts');
  });

  it('list_dir: a scripted tool_call returns the real top-level listing', async () => {
    const llm = scripted([
      toolCall('c1', 'list_dir', '{"path":"src/tools"}'),
      [{ type: 'text_delta', content: 'done' }],
    ]);
    const loop = new AgentLoop({
      llm,
      toolRegistry: searchRegistry(),
      toolExecutionPipeline: pipeline(),
      config: { maxToolRounds: 5, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
    await loop.processUserInput('what is in src/tools');
    const toolMsg = loop.getMessages().find((m) => m.role === 'tool');
    const content = String(toolMsg?.content ?? '');
    expect(content).toContain('grep.ts');
    expect(content).toContain('glob.ts');
  });
});
