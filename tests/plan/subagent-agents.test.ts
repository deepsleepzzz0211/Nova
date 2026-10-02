import { describe, it, expect, vi } from 'vitest';
import { SubagentSpawner } from '../../src/subagent/spawner.js';
import type { AgentDefinition } from '../../src/subagent/agents.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool } from '../../src/tools/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';

// Batch-B ticket 05: named agent definitions (~/.nova/agents/<name>.toml)
// narrow a subagent's tool surface / model tier / prompt. Definitions can
// only REMOVE surface (guardrail + ask-inheritance unchanged); an unknown
// name errors instead of silently widening to the default spawn.

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

function fakeTool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: `${name} ran` }),
    ...extra,
  };
}

/** LLM that calls `firstTool` once, then summarizes. Records every chat call. */
function recordingLLM(firstTool: string): {
  llm: LLMProvider;
  chats: Array<{ msgs: Message[]; opts: ChatOptions }>;
} {
  const chats: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
  const llm: LLMProvider = {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
      chats.push({ msgs: [...msgs], opts });
      const lastToolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
      if (!lastToolMsg) {
        yield { type: 'tool_call_start', id: 's1', name: firstTool };
        yield { type: 'tool_call_delta', id: 's1', arguments: '{}' };
        yield { type: 'tool_call_end', id: 's1' };
        return;
      }
      yield { type: 'text_delta', content: `DONE after ${firstTool}` };
    },
  };
  return { llm, chats };
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'reviewer',
    description: 'reads only',
    tools: ['reader'],
    prompt: 'Review carefully and report findings.',
    readOnly: false,
    ...overrides,
  };
}

function toolNames(opts: ChatOptions | undefined): string[] {
  return (opts?.tools ?? []).map(
    (t) => (t as { name?: string; function?: { name?: string } }).name ?? t.function?.name ?? '?',
  );
}

describe('named agent routing in the spawner (ticket 05)', () => {
  it('whitelist narrows the child tool surface', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader'));
    registry.register(fakeTool('writer'));
    const { llm, chats } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      agents: new Map([['a', definition({ tools: ['reader'] })]]),
    });
    await spawner.run('task', { agent: 'a' });
    expect(toolNames(chats[0].opts)).toEqual(['reader']);
  });

  it('readOnly physically strips fileAccess=write tools even when whitelisted', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader', { fileAccess: 'read' }));
    registry.register(fakeTool('writer', { fileAccess: 'write' }));
    const { llm, chats } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      agents: new Map([['a', definition({ tools: ['reader', 'writer'], readOnly: true })]]),
    });
    await spawner.run('task', { agent: 'a' });
    expect(toolNames(chats[0].opts)).toEqual(['reader']);
  });

  it('the definition prompt replaces the generic subagent guidance', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader'));
    const { llm, chats } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      agents: new Map([['a', definition({ prompt: 'CUSTOM-AGENT-PROMPT-TEXT' })]]),
    });
    await spawner.run('task', { agent: 'a' });
    const system = chats[0].opts.systemPrompt ?? '';
    expect(system).toContain('CUSTOM-AGENT-PROMPT-TEXT');
    expect(system).not.toContain('focused subagent');
  });

  it('CHILD_FORBIDDEN_TOOLS beats the whitelist (recursion stays out)', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader'));
    registry.register(fakeTool('spawn_subagent'));
    const { llm, chats } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      agents: new Map([['a', definition({ tools: ['reader', 'spawn_subagent'] })]]),
    });
    await spawner.run('task', { agent: 'a' });
    expect(toolNames(chats[0].opts)).toEqual(['reader']);
  });

  it('a definition model slots under the per-call spec in routing', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader'));
    const { llm } = recordingLLM('reader');
    const resolve = vi.fn((spec: string) => ({ ok: true as const, llm, model: `resolved:${spec}` }));
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'parent-model',
      resolveModelSpec: resolve,
      agents: new Map([['a', definition({ model: 'cheap-model' })]]),
    });
    const result = await spawner.run('task', { agent: 'a' });
    expect(resolve).toHaveBeenCalledWith('cheap-model');
    expect(result.summary).toContain('DONE');
  });

  it('unknown agent name errors without spawning and lists known names', async () => {
    const registry = new ToolRegistry();
    const reader = fakeTool('reader');
    registry.register(reader);
    const spy = vi.spyOn(reader, 'execute');
    const { llm } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      agents: new Map([['reviewer', definition()]]),
    });
    await expect(spawner.run('task', { agent: 'nope' })).rejects.toThrow(/Unknown agent "nope"/);
    await expect(spawner.run('task', { agent: 'nope' })).rejects.toThrow(/reviewer/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('no agent option keeps today\'s child surface and guidance', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('reader'));
    registry.register(fakeTool('writer'));
    registry.register(fakeTool('spawn_subagent'));
    const { llm, chats } = recordingLLM('reader');
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });
    await spawner.run('task');
    expect(toolNames(chats[0].opts).sort()).toEqual(['reader', 'writer']);
    expect(chats[0].opts.systemPrompt).toContain('focused subagent');
  });
});
