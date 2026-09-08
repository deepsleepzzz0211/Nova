import { describe, it, expect, vi } from 'vitest';
import { SubagentSpawner } from '../../src/subagent/spawner.js';
import { createSpawnSubagentTool } from '../../src/subagent/tool.js';
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

function bashTool(): Tool {
  return {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (params) => ({ content: `$ ${String(params.command)}` }),
  };
}

/** LLM that always wants one bash call, then reports. */
function toolCallingLLM(): { llm: LLMProvider; chats: Array<{ msgs: Message[]; opts: ChatOptions }> } {
  const chats: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
  const llm: LLMProvider = {
    async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      chats.push({ msgs: [...msgs], opts });
      const lastToolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
      if (!lastToolMsg) {
        yield { type: 'tool_call_start', id: 's1', name: 'bash' };
        yield { type: 'tool_call_delta', id: 's1', arguments: '{"command":"echo subagent-work"}' };
        yield { type: 'tool_call_end', id: 's1' };
        return;
      }
      yield { type: 'text_delta', content: `SUBAGENT SUMMARY: ${lastToolMsg.content}` };
    },
  };
  return { llm, chats };
}

describe('SubagentSpawner', () => {
  it('runs a task in an independent context and returns only the final summary', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm, chats } = toolCallingLLM();

    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });

    const result = await spawner.run('Count the files in src/');
    expect(result.summary).toContain('SUBAGENT SUMMARY');
    expect(result.rounds).toBe(2);
    // Independent context: subagent conversation starts from its own task,
    // not from any parent history
    expect(chats[0].msgs[0].role).toBe('user');
    expect((chats[0].msgs[0] as { content: string }).content).toContain('Count the files in src/');
  });

  it('denies ask-level tools when no permission callback is inherited', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const llm: LLMProvider = {
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const sawDenial = msgs.some((m) => m.role === 'tool' && m.content.includes('denied'));
        if (!sawDenial) {
          yield { type: 'tool_call_start', id: 's1', name: 'bash' };
          yield { type: 'tool_call_delta', id: 's1', arguments: '{"command":"rm -rf /"}' };
          yield { type: 'tool_call_end', id: 's1' };
          return;
        }
        yield { type: 'text_delta', content: 'could not run the command' };
      },
    };

    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });

    const result = await spawner.run('do something destructive');
    // bash is not always-allowed → ask → no confirm callback → denied
    expect(result.summary).toContain('could not run');
  });

  it('inherits permission confirmation through the provided callback', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm } = toolCallingLLM();

    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });

    const result = await spawner.run('run the command', {
      confirm: async () => true,
    });
    expect(result.summary).toContain('echo subagent-work');
  });

  it('stops the subagent after maxRounds', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'tool_call_start', id: 's1', name: 'bash' };
        yield { type: 'tool_call_delta', id: 's1', arguments: '{"command":"x"}' };
        yield { type: 'tool_call_end', id: 's1' };
      },
    };

    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });

    const result = await spawner.run('loop forever', { maxRounds: 3 });
    expect(result.rounds).toBe(4); // maxRounds + 1
    expect(result.summary).toContain('did not complete');
  });
});

describe('SubagentSpawner guardrails (ticket 01)', () => {
  it('child never sees spawn_subagent in its tool list', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm, chats } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });
    registry.register(createSpawnSubagentTool(spawner)); // parent has it

    await spawner.run('do work');
    const childTools = (chats[0].opts.tools ?? []).map((t) => t.function.name);
    expect(childTools).toContain('bash');
    expect(childTools).not.toContain('spawn_subagent');
  });

  it('blocks spawning beyond the concurrency limit with a retry-hint error', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    // Slow LLM: holds each subagent open long enough to overlap
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        await new Promise((r) => setTimeout(r, 200));
        yield { type: 'text_delta', content: 'done' };
      },
    };
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      maxConcurrent: 2,
    });
    const tool = createSpawnSubagentTool(spawner);
    const ctx = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

    const results = await Promise.all([
      tool.execute({ task: 'a' }, ctx, { confirm: async () => true }),
      tool.execute({ task: 'b' }, ctx, { confirm: async () => true }),
      tool.execute({ task: 'c' }, ctx, { confirm: async () => true }),
      tool.execute({ task: 'd' }, ctx, { confirm: async () => true }),
    ]);
    const ok = results.filter((r) => !r.isError);
    const blocked = results.filter((r) => r.isError);
    expect(ok).toHaveLength(2); // limit reached, not exceeded
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    for (const b of blocked) {
      expect(b.content.toLowerCase()).toContain('concurrent subagent limit');
      expect(b.content).toContain('retry'); // tells the parent to retry later
    }
    // Slots released after completion: a new spawn works
    const after = await tool.execute({ task: 'e' }, ctx, { confirm: async () => true });
    expect(after.isError).toBeUndefined();
  });

  it('concurrency limit defaults to 3 and is configurable', () => {
    const mk = (max?: number) => new SubagentSpawner({
      llm: toolCallingLLM().llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      ...(max !== undefined ? { maxConcurrent: max } : {}),
    });
    expect(mk().maxConcurrent).toBe(3);
    expect(mk(7).maxConcurrent).toBe(7);
  });
});

describe('spawn_subagent tool', () => {
  it('wraps the spawner and returns the summary as tool result', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm } = toolCallingLLM();

    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });

    const tool = createSpawnSubagentTool(spawner);
    expect(tool.name).toBe('spawn_subagent');
    expect(tool.metadata?.cacheable).toBe(false);

    const result = await tool.execute(
      { task: 'Count the files', context: 'in src/agent' },
      { workingDirectory: process.cwd(), abortSignal: new AbortController().signal },
      { confirm: async () => true },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('SUBAGENT SUMMARY');
  });

  it('requires permission', () => {
    const registry = new ToolRegistry();
    const { llm } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });
    const tool = createSpawnSubagentTool(spawner);
    expect(tool.requiresPermission?.({ task: 'x' })).toBe(true);
  });
});
