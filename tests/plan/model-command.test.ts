import { describe, it, expect } from 'vitest';
import { loadModelCatalog, describeModels, parseModelSpec } from '../../src/llm/catalog.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
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

describe('parseModelSpec', () => {
  it('parses bare ids against the current provider', () => {
    expect(parseModelSpec('gpt-4o-mini', 'openai')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('parses provider/model specs', () => {
    expect(parseModelSpec('anthropic/claude-3-haiku-20240307', 'openai')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
    });
  });
});

describe('describeModels', () => {
  it('lists models with context window, reasoning flag, and current marker', () => {
    const catalog = loadModelCatalog([]);
    const listing = describeModels(catalog, 'openai', 'gpt-4o');
    expect(listing).toContain('Provider: openai');
    expect(listing).toContain('* gpt-4o'); // current model marked
    expect(listing).toContain('gpt-4o-mini');
    expect(listing).toContain('ctx 128,000');
    expect(listing).toContain('/model <id>');
  });

  it('reports unknown providers', () => {
    const catalog = loadModelCatalog([]);
    expect(describeModels(catalog, 'nope', 'm')).toContain('Unknown provider: nope');
  });
});

describe('AgentLoop setModel/setProvider', () => {
  function fakeLLM(tag: string): { llm: LLMProvider; models: string[] } {
    const models: string[] = [];
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        models.push(`${tag}:${opts.model}`);
        yield { type: 'text_delta', content: tag };
      },
    };
    return { llm, models };
  }

  it('uses the switched provider and model for subsequent turns', async () => {
    const first = fakeLLM('first');
    const second = fakeLLM('second');

    const loop = new AgentLoop({
      llm: first.llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'gpt-4o' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('one');
    loop.setProvider(second.llm);
    loop.setModel('gpt-4o-mini');
    await loop.processUserInput('two');

    expect(first.models).toEqual(['first:gpt-4o']);
    expect(second.models).toEqual(['second:gpt-4o-mini']);
  });
});
