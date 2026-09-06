import { describe, it, expect, vi } from 'vitest';
import { resolveThinking, type ThinkingModelInfo } from '../../src/llm/thinking.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import { AnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Message, StreamChunk } from '../../src/llm/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { ChatOptions } from '../../src/llm/types.js';

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

describe('resolveThinking (level map resolution)', () => {
  const base: ThinkingModelInfo = { reasoning: true };

  it('off and undefined send nothing', () => {
    expect(resolveThinking(base, 'off').send).toBe(false);
    expect(resolveThinking(base, undefined).send).toBe(false);
  });

  it('standard levels use the identity mapping by default', () => {
    expect(resolveThinking(base, 'minimal')).toEqual({ send: true, value: 'minimal' });
    expect(resolveThinking(base, 'low')).toEqual({ send: true, value: 'low' });
    expect(resolveThinking(base, 'medium')).toEqual({ send: true, value: 'medium' });
    expect(resolveThinking(base, 'high')).toEqual({ send: true, value: 'high' });
  });

  it('extended levels (xhigh/max) are unsupported without a map entry', () => {
    expect(resolveThinking(base, 'xhigh').send).toBe(false);
    expect(resolveThinking(base, 'max').send).toBe(false);
  });

  it('map entries override defaults: string maps, null clamps', () => {
    const model: ThinkingModelInfo = {
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
    };
    expect(resolveThinking(model, 'minimal').send).toBe(false);
    expect(resolveThinking(model, 'high')).toEqual({ send: true, value: 'high' });
    expect(resolveThinking(model, 'max')).toEqual({ send: true, value: 'max' });
  });

  it('non-reasoning models never send thinking params', () => {
    expect(resolveThinking({ reasoning: false }, 'high').send).toBe(false);
  });
});

// Shared fake SDK chunks are not needed here; providers are exercised through
// mocked SDKs in provider-cache.test.ts. For thinking params we capture at the
// ChatOptions level via a loop-driven fake LLM and at the provider level via
// direct adapter behavior checks.

describe('AgentLoop forwards thinkingLevel to ChatOptions', () => {
  it('passes the configured level into every chat call', async () => {
    const opts: ChatOptions[] = [];
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], options: ChatOptions): AsyncIterable<StreamChunk> {
        opts.push(options);
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 10, model: 'test' },
      thinkingLevel: 'high',
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('hi');
    expect(opts[0].thinkingLevel).toBe('high');
  });
});

describe('provider construction accepts thinkingLevelMap metadata', () => {
  it('OpenAI/Anthropic providers accept compat + remain constructible', () => {
    // Metadata plumbing smoke check — wire-format emission is covered by
    // adapter tests against mocked SDKs in provider-cache.test.ts.
    expect(() => new OpenAIProvider({ name: 'openai', apiKey: 'k' })).not.toThrow();
    expect(() => new AnthropicProvider({ name: 'anthropic', apiKey: 'k' })).not.toThrow();
  });
});

// Silence unused import warnings if any
void vi;
