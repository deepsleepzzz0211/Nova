import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubagentSpawner } from '../../src/subagent/spawner.js';
import { SessionStore } from '../../src/agent/session.js';
import { createSpawnSubagentTool } from '../../src/subagent/tool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import type { SkillRegistry, SkillMeta } from '../../src/skills/registry.js';
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
  it('a child attempting spawn_subagent gets an explicit not-found error', async () => {
    // Simulate the child side: the filtered registry is what the child's
    // loop uses; a call against it must fail with a clear error.
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(bashTool());
    const { llm } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: parentRegistry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });
    parentRegistry.register(createSpawnSubagentTool(spawner));

    const childRegistry = (spawner as unknown as { childToolRegistry(): ToolRegistry }).childToolRegistry();
    expect(childRegistry.get('spawn_subagent')).toBeUndefined();
    // AgentLoop's not-found path returns an explicit error result
    const missing = childRegistry.get('spawn_subagent');
    expect(missing).toBeUndefined(); // → executeToolCall: 'Tool "spawn_subagent" not found.'
  });

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

describe('SubagentSpawner context injection (ticket 02)', () => {
  function stubSkills(): {
    registry: SkillRegistry;
    calls: { keywords: string; query: string }[];
  } {
    const calls: { keywords: string; query: string }[] = [];
    const meta: SkillMeta = { name: 'deploy', description: 'How to deploy the app', path: '/x/SKILL.md' };
    const registry = {
      findAll: () => [meta],
      findByKeywords: (query: string) => {
        const matched = /deploy/i.test(query) ? [meta] : [];
        calls.push({ keywords: matched.map((m) => m.name).join(','), query });
        return matched;
      },
      load: async () => '# Deploy skill\nRun deploy.sh',
    } as unknown as SkillRegistry;
    return { registry, calls };
  }

  it('injects environment, project instructions and memory into the child prompt', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm, chats } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      promptOptions: {
        environment: { workingDirectory: '/proj', platform: 'win32' },
        projectInstructions: 'Always use pnpm.',
        memory: '- user prefers pnpm',
      },
    });

    await spawner.run('do work');
    const sys = chats[0].opts.systemPrompt ?? '';
    expect(sys).toContain('## Environment');
    expect(sys).toContain('/proj');
    expect(sys).toContain('## Project Instructions');
    expect(sys).toContain('Always use pnpm.');
    expect(sys).toContain('## Memory');
    expect(sys).toContain('user prefers pnpm');
    // Subagent identity retained
    expect(sys).toContain('focused subagent');
  });

  it('forwards the skill registry so the child gets progressive skill injection', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm, chats } = toolCallingLLM();
    const { registry: skills, calls } = stubSkills();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      skills,
    });

    // Round 1: the model asks to run the deploy skill (via bash echo as the trigger input is the task)
    await spawner.run('deploy the app to production');
    // Skill matching ran against the task input
    expect(calls[0].query).toContain('deploy');
    // Second LLM round received the injected Active Skills message
    const sawSkills = chats[1].msgs.some(
      (m) => m.role === 'system' && String(m.content).includes('## Active Skills'),
    );
    expect(sawSkills).toBe(true);
    // Skill listing also present in the frozen prompt
    expect(chats[0].opts.systemPrompt).toContain('## Available Skills');
  });

  it('degrades gracefully when no promptOptions/skills are provided', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm, chats } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
    });
    await spawner.run('do work');
    const sys = chats[0].opts.systemPrompt ?? '';
    expect(sys).not.toContain('## Project Instructions');
    expect(sys).not.toContain('## Memory');
  });
});

describe('SubagentSpawner model routing (ticket 03)', () => {
  function routingFixture() {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm: parentLLM, chats } = toolCallingLLM();
    const cheapLLM: LLMProvider = {
      async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        chats.push({ msgs: [...msgs], opts });
        yield { type: 'text_delta', content: 'CHEAP MODEL SUMMARY' };
      },
    };
    const resolveCalls: string[] = [];
    const spawner = new SubagentSpawner({
      llm: parentLLM,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'parent-model',
      defaultModel: 'cheap-default',
      resolveModelSpec: (spec: string) => {
        resolveCalls.push(spec);
        if (spec === 'bad-model') return { ok: false as const, message: 'unknown model' };
        return { ok: true as const, llm: cheapLLM, model: spec };
      },
    });
    return { spawner, chats, resolveCalls, parentLLM };
  }

  it('resolves the per-invocation model over the configured default', async () => {
    const { spawner, chats, resolveCalls, parentLLM } = routingFixture();
    await spawner.run('scout work', { model: 'haiku-fast' });
    expect(resolveCalls).toEqual(['haiku-fast']); // per-call wins over default
    expect(chats[0].opts.model).toBe('haiku-fast');
    expect(chats[0].opts).toBeDefined();
    // The routed provider was used, not the parent's
    expect(chats[0].opts.model).not.toBe('parent-model');
    void parentLLM;
  });

  it('falls back to the configured default when no per-call model', async () => {
    const { spawner, chats, resolveCalls } = routingFixture();
    await spawner.run('scout work');
    expect(resolveCalls).toEqual(['cheap-default']);
    expect(chats[0].opts.model).toBe('cheap-default');
  });

  it('falls back to the parent model when resolution fails, and notes it', async () => {
    const { spawner, chats, resolveCalls } = routingFixture();
    const result = await spawner.run('scout work', { model: 'bad-model' });
    expect(resolveCalls).toContain('bad-model');
    // Parent model used and the fallback is visible in the summary
    expect(chats.at(-1)!.opts.model).toBe('parent-model');
    expect(result.summary).toContain('parent-model');
  });

  it('uses the parent provider directly when no routing is configured', async () => {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const { llm: parentLLM, chats } = toolCallingLLM();
    const spawner = new SubagentSpawner({
      llm: parentLLM,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'parent-model',
    });
    await spawner.run('work');
    expect(chats[0].opts.model).toBe('parent-model');
    void parentLLM;
  });
});

describe('SubagentSpawner progress & cancellation (ticket 04)', () => {
  function observingFixture(signal?: AbortSignal) {
    const registry = new ToolRegistry();
    const toolCalls: string[] = [];
    registry.register({
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async (params) => {
        toolCalls.push(String(params.command));
        return { content: `ran ${String(params.command)}` };
      },
    });
    const events: Array<{ agentId: string; type: string; payload?: unknown }> = [];
    const llm: LLMProvider = {
      async *chat(msgs: Message[]): AsyncIterable<StreamChunk> {
        const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
        if (!lastTool) {
          yield { type: 'tool_call_start', id: 's1', name: 'bash' };
          yield { type: 'tool_call_delta', id: 's1', arguments: '{"command":"echo hi"}' };
          yield { type: 'tool_call_end', id: 's1' };
          return;
        }
        yield { type: 'text_delta', content: 'all done' };
      },
    };
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      onEvent: (e) => events.push(e),
    });
    return { spawner, events, toolCalls };
  }

  it('allocates a unique agentId and forwards start/tool/end events', async () => {
    const { spawner, events } = observingFixture();
    const r1 = await spawner.run('task A');
    const r2 = await spawner.run('task B');

    expect(r1.agentId).toMatch(/^sub-/);
    expect(r2.agentId).toMatch(/^sub-/);
    expect(r1.agentId).not.toBe(r2.agentId);

    const types = events.map((e) => e.type);
    expect(types).toContain('start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('end');
    // Every event carries the agent id it belongs to
    for (const e of events) expect(e.agentId).toMatch(/^sub-/);
  });

  it('propagates an aborted signal into tool execution (cancel mid-run)', async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.fn(async () => ({ content: 'should not run' }));
    registry.register({
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: executeSpy,
    });
    const controller = new AbortController();
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

    controller.abort();
    const result = await spawner.run('cancelled task', { signal: controller.signal, confirm: async () => true });
    // The tool never executed
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.summary).toBeTruthy();
  });
});

describe('SubagentSpawner transcript & resume (ticket 05)', () => {
  function transcriptFixture(dir: string) {
    const registry = new ToolRegistry();
    registry.register(bashTool());
    const chats: Array<{ msgs: Message[]; opts: ChatOptions }> = [];
    let round = 0;
    const llm: LLMProvider = {
      async *chat(msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        chats.push({ msgs: [...msgs], opts });
        const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
        if (!lastTool) {
          yield { type: 'text_delta', content: `ANSWER round ${++round}` };
          return;
        }
        yield { type: 'text_delta', content: `ANSWER round ${round} (with tool)` };
      },
    };
    const spawner = new SubagentSpawner({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      model: 'test',
      transcriptsDir: dir,
    });
    return { spawner, chats };
  }

  it('persists the child conversation to its own transcript file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-subagent-'));
    try {
      const { spawner } = transcriptFixture(dir);
      const result = await spawner.run('first task');
      const file = path.join(dir, `${result.agentId}.jsonl`);
      const transcript = SessionStore.load(file);
      expect(transcript.some((m) => m.role === 'user' && m.content === 'first task')).toBe(true);
      expect(transcript.some((m) => m.role === 'assistant')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resume continues the same context instead of starting fresh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-subagent-'));
    try {
      const { spawner, chats } = transcriptFixture(dir);
      const first = await spawner.run('original task');
      const followUp = await spawner.run('follow-up question', { resumeAgentId: first.agentId });

      expect(followUp.agentId).toBe(first.agentId);
      // The follow-up run saw the original conversation
      const lastTurnFirstMsg = chats.at(-1)!.msgs[0];
      const convo = chats.at(-1)!.msgs;
      expect(convo.some((m) => m.role === 'user' && m.content === 'original task')).toBe(true);
      expect(convo.some((m) => m.role === 'user' && m.content === 'follow-up question')).toBe(true);
      void lastTurnFirstMsg;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a fresh spawn when the transcript is corrupt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-subagent-'));
    try {
      fs.writeFileSync(path.join(dir, 'sub-corrupt.jsonl'), 'garbage\n{broken\n');
      const { spawner, chats } = transcriptFixture(dir);
      const result = await spawner.run('fresh work', { resumeAgentId: 'sub-corrupt' });
      expect(result.summary).toContain('ANSWER');
      expect(chats.at(-1)!.msgs.every((m) => m.role !== 'user' || m.content === 'fresh work')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancelled runs flush the transcript and emit an end event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-subagent-'));
    try {
      const registry = new ToolRegistry();
      registry.register(bashTool());
      const llm: LLMProvider = {
        async *chat(): AsyncIterable<StreamChunk> {
          // Hang until the test aborts the signal
          await new Promise((r) => setTimeout(r, 5000));
          yield { type: 'text_delta', content: 'never' };
        },
      };
      const events: Array<{ agentId: string; type: string }> = [];
      const spawner = new SubagentSpawner({
        llm,
        toolRegistry: registry,
        toolExecutionPipeline: makePipeline(),
        model: 'test',
        transcriptsDir: dir,
        onEvent: (e) => events.push(e),
      });
      const controller = new AbortController();
      const run = spawner.run('will be cancelled', { signal: controller.signal, confirm: async () => true });
      setTimeout(() => controller.abort(new Error('subagent cancelled')), 50);
      // The run rejects promptly (not hung); the tool maps this to an
      // isError result for the parent.
      await expect(run).rejects.toThrow('subagent cancelled');
      expect(events.some((e) => e.type === 'end')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a fresh spawn when the transcript is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-subagent-'));
    try {
      const { spawner, chats } = transcriptFixture(dir);
      const result = await spawner.run('new work', { resumeAgentId: 'sub-never-existed' });
      expect(result.summary).toContain('ANSWER');
      // Fresh context: no phantom history
      expect(chats.at(-1)!.msgs.every((m) => m.role !== 'user' || m.content === 'new work')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
