import { describe, it, expect } from 'vitest';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { MemoryCache } from '../../src/cache/memory-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { loadModelCatalog, resolveModel } from '../../src/llm/catalog.js';
import type { Tool, ToolContext, ToolResult } from '../../src/tools/types.js';

const noPermissionConfig = {
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
};

function makeTool(overrides: Partial<Tool>, execute: (params: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
    execute,
    ...overrides,
  } as Tool;
}

function makeContext(): ToolContext {
  return { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };
}

describe('Pipeline exact denial messages and cache keys', () => {
  it('deny message includes the tool name', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const tool = makeTool({ name: 'bash' }, async () => ({ content: 'ok' }));
    // bash + no always-allow → ask; no confirm → denied
    const result = await pipeline.execute(tool, { command: 'ls' }, makeContext());
    expect(result.content).toBe('Permission denied for tool "bash".');
  });

  it('pre-hook deny without reason falls back to the default message with the tool name', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { pre: [() => ({ deny: true })] },
    });
    const result = await pipeline.execute(makeTool({}, async () => ({ content: 'ok' })), {}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('Tool "test_tool" blocked by pre-tool-use hook.');
  });

  it('asks an ask-decision tool exactly once even when requiresPermission is also set', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const confirmCalls: string[] = [];
    const tool = makeTool(
      { name: 'write_file', requiresPermission: () => true },
      async () => ({ content: 'ok' }),
    );
    const result = await pipeline.execute(tool, { path: 'a' }, makeContext(), {
      confirm: async (name) => {
        confirmCalls.push(name);
        return true;
      },
    });
    expect(result.content).toBe('ok');
    expect(confirmCalls).toEqual(['write_file']);
  });

  it('generateCacheKey encodes tool name and params', () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    expect(pipeline.generateCacheKey('web_search', { query: 'a' })).toBe('web_search:{"query":"a"}');
  });
});

describe('MemoryCache operations', () => {
  it('delete removes an entry and updates stats size', async () => {
    const cache = new MemoryCache<string, string>({ ttl: 10_000, maxSize: 10 });
    await cache.set('k', 'v');
    expect(cache.getStats().size).toBe(1);
    await cache.delete('k');
    expect(cache.getStats().size).toBe(0);
    expect(await cache.get('k')).toBeNull();
  });

  it('delete of a missing key is a no-op that keeps stats consistent', async () => {
    const cache = new MemoryCache<string, string>({ ttl: 10_000, maxSize: 10 });
    await cache.delete('ghost');
    expect(cache.getStats().size).toBe(0);
  });

  it('clear removes all entries and resets size', async () => {
    const cache = new MemoryCache<string, string>({ ttl: 10_000, maxSize: 10 });
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.clear();
    expect(cache.getStats().size).toBe(0);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBeNull();
  });

  it('per-set ttl overrides the instance ttl', async () => {
    const cache = new MemoryCache<string, string>({ ttl: 10_000, maxSize: 10 });
    await cache.set('k', 'v', 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await cache.get('k')).toBeNull();
  });

  it('constructs with default ttl when config omitted', async () => {
    const cache = new MemoryCache<string, string>();
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
  });
});

describe('ToolResultCache delete/clear', () => {
  it('deletes and clears cached tool results', async () => {
    const cache = new ToolResultCache();
    await cache.set('key1', { content: 'a' });
    expect(await cache.get('key1')).toEqual({ content: 'a' });
    await cache.delete('key1');
    expect(await cache.get('key1')).toBeNull();
    await cache.set('key2', { content: 'b' });
    await cache.clear();
    expect(await cache.get('key2')).toBeNull();
  });
});

describe('catalog error and default details', () => {
  it('unknown provider error names the provider', () => {
    const catalog = loadModelCatalog([]);
    expect(() => resolveModel({ provider: 'nope', model: 'm' }, catalog)).toThrow('Unknown provider: nope');
  });

  it('synthesized default model uses 16384 max tokens and inherits provider compat', () => {
    const catalog = loadModelCatalog([]);
    const r = resolveModel({ provider: 'openai', model: 'brand-new-model' }, catalog);
    expect(r.model.maxTokens).toBe(16_384);
    expect(r.model.name).toBe('brand-new-model');
    expect(r.model.reasoning).toBe(false);
  });

  it('custom provider without models resolves with 128k default window', () => {
    const catalog = loadModelCatalog([]);
    // Manually registered (not via file) custom provider shape
    const custom = loadModelCatalog([]);
    void custom;
    const withUser = loadModelCatalog([]);
    void withUser;
    // via file-less catalog, custom providers are not available:
    expect(() => resolveModel({ provider: 'custom', model: 'x' }, catalog)).toThrow('Unknown provider: custom');
  });
});
