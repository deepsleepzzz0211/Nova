import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { PromptCacheMetrics } from '../../src/cache/prompt-cache-metrics.js';
import { SkillRegistry } from '../../src/skills/registry.js';
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

describe('Stable prompt prefix (cache-friendly design)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cache-'));
    const skillDir = path.join(tmp, 'debugging');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when debugging bugs and errors\n---\n# Debugging\nRead the stack trace first.',
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the system prompt byte-identical across turns, even when a skill activates', async () => {
    const registry = new SkillRegistry();
    await registry.scan(tmp);

    const systemPrompts: string[] = [];
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        systemPrompts.push(opts.systemPrompt ?? '');
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      skills: registry,
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('what is the weather'); // no skill match
    await loop.processUserInput('help me debug these bugs'); // skill match

    // Frozen prefix: identical system prompt in every round
    expect(systemPrompts.length).toBe(2);
    expect(systemPrompts[0]).toBe(systemPrompts[1]);
    expect(systemPrompts[0].length).toBeGreaterThan(0);

    // Skill body travels as an append-only message, not inside the system prompt
    const history = loop.getMessages();
    const skillMessage = history.find((m) => m.role === 'system' && m.content.includes('Read the stack trace first.'));
    expect(skillMessage).toBeDefined();
    expect(systemPrompts[0]).not.toContain('Read the stack trace first.');
  });

  it('appends skill messages after existing history (append-only)', async () => {
    const registry = new SkillRegistry();
    await registry.scan(tmp);

    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      skills: registry,
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('earlier question');
    const historyBefore = loop.getMessages().length;

    await loop.processUserInput('help me debug these bugs');
    const historyAfter = loop.getMessages();

    // Pure append: every earlier message is unchanged and in place
    for (let i = 0; i < historyBefore; i++) {
      expect(historyAfter[i]).toEqual(loop.getMessages()[i]);
    }
  });
});

describe('Deterministic tool definitions', () => {
  it('sorts tool definitions by name for a stable request prefix', () => {
    const registry = new ToolRegistry();
    for (const name of ['web_fetch', 'bash', 'edit_file', 'read_file']) {
      registry.register({
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: 'ok' }),
      });
    }

    const names = registry.toToolDefinitions().map((d) => d.function.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(['bash', 'edit_file', 'read_file', 'web_fetch']);
  });
});

describe('PromptCacheMetrics', () => {
  it('accumulates usage and computes hit rate', () => {
    const metrics = new PromptCacheMetrics();
    // input includes cached+written+uncached (normalized)
    metrics.record({ inputTokens: 1000, cachedInputTokens: 800, cacheWriteTokens: 100, outputTokens: 50 });
    metrics.record({ inputTokens: 1100, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 60 });

    expect(metrics.totalInputTokens).toBe(2100);
    expect(metrics.totalCachedTokens).toBe(1800);
    expect(metrics.totalCacheWriteTokens).toBe(100);
    expect(metrics.totalOutputTokens).toBe(110);
    // hit rate = cached / input
    expect(metrics.hitRate).toBeCloseTo(1800 / 2100, 6);
    // latest-turn hit rate
    expect(metrics.latestHitRate).toBeCloseTo(1000 / 1100, 6);
  });

  it('handles zero usage gracefully', () => {
    const metrics = new PromptCacheMetrics();
    expect(metrics.hitRate).toBe(0);
    expect(metrics.latestHitRate).toBe(0);
  });
});

describe('AgentLoop usage aggregation', () => {
  it('collects usage chunks from all rounds into onUsage per turn', async () => {
    const toolChunks: StreamChunk[] = [
      { type: 'tool_call_start', id: 'c1', name: 'echo' },
      { type: 'tool_call_end', id: 'c1' },
    ];
    let callIndex = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'usage', inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 };
          for (const c of toolChunks) yield c;
          return;
        }
        yield { type: 'usage', inputTokens: 150, outputTokens: 20, cachedInputTokens: 140 };
        yield { type: 'text_delta', content: 'done' };
      },
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    });

    const turns: Array<{ inputTokens: number; cachedInputTokens?: number; outputTokens: number }> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onUsage: (usage) => turns.push(usage),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('go');

    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBe(250); // summed across rounds
    expect(turns[0].cachedInputTokens).toBe(220);
    expect(turns[0].outputTokens).toBe(30);
  });
});
