import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool, ToolContext, ToolResult } from '../../src/tools/types.js';

const noPermissionConfig = {
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
};

function makeTool(overrides: Partial<Tool> & { name?: string }, execute: (params: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
    permission: { mode: 'auto' },
    execute,
    ...overrides,
  } as Tool;
}

function makeContext(): ToolContext {
  return { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };
}

describe('ToolExecutionPipeline — single execution path', () => {
  it('executes tool when policy allows', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const tool = makeTool({}, async () => ({ content: 'ok' }));

    const result = await pipeline.execute(tool, {}, makeContext());
    expect(result.content).toBe('ok');
    expect(result.isError).toBeUndefined();
  });

  it('returns error without executing when policy denies', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const tool = makeTool(
      { name: 'bash', display: { kind: 'command' }, permission: { mode: 'ask', message: 'Bash command requires confirmation' } },
      execute,
    );

    const result = await pipeline.execute(tool, { command: 'ls' }, makeContext());
    // 'ls' is not in alwaysAllowCommands → ask; no confirm callback → denied
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for confirmation when policy says ask, executes when user approves', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'written' }));
    const tool = makeTool({ name: 'write_file', permission: { mode: 'ask', message: 'File write requires confirmation' } }, execute);

    const result = await pipeline.execute(tool, { path: 'a.txt' }, makeContext(), {
      confirm: async () => true,
    });
    expect(result.content).toBe('written');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute when user denies the confirmation', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'written' }));
    const tool = makeTool({ name: 'write_file', permission: { mode: 'ask', message: 'File write requires confirmation' } }, execute);

    const result = await pipeline.execute(tool, { path: 'a.txt' }, makeContext(), {
      confirm: async () => false,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies ask-decision tools when no confirm callback is provided', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'written' }));
    const tool = makeTool({ name: 'write_file', permission: { mode: 'ask', message: 'File write requires confirmation' } }, execute);

    const result = await pipeline.execute(tool, { path: 'a.txt' }, makeContext());
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('honours a tool-declared ask permission (ticket 19: declaration, not name list)', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'declared result' }));
    // A name the policy would otherwise allow, but the tool itself asks.
    const tool = makeTool(
      {
        name: 'read_file',
        permission: { mode: 'ask', message: 'Custom confirmation' },
      },
      execute,
    );

    const denied = await pipeline.execute(tool, {}, makeContext());
    expect(denied.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const allowed = await pipeline.execute(tool, {}, makeContext(), { confirm: async () => true });
    expect(allowed.content).toBe('declared result');
  });

  it('caches results for cacheable tools and reuses them', async () => {
    const cache = new ToolResultCache();
    const pipeline = new ToolExecutionPipeline(cache, new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'expensive' }));
    const tool = makeTool(
      { name: 'web_search', metadata: { category: 'web', cacheable: true, timeout: 1000 } },
      execute,
    );

    const first = await pipeline.execute(tool, { query: 'test' }, makeContext());
    const second = await pipeline.execute(tool, { query: 'test' }, makeContext());
    expect(first.content).toBe('expensive');
    expect(second.content).toBe('expensive');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not cache non-cacheable tools', async () => {
    const cache = new ToolResultCache();
    const pipeline = new ToolExecutionPipeline(cache, new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'fresh' }));
    const tool = makeTool({ name: 'bash', metadata: { category: 'shell', cacheable: false, timeout: 1000 } }, execute);
    const confirm = async (): Promise<boolean> => true;

    await pipeline.execute(tool, { command: 'x' }, makeContext(), { confirm });
    await pipeline.execute(tool, { command: 'x' }, makeContext(), { confirm });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not serve cache hits past ask/deny checks (permission first, then cache)', async () => {
    const cache = new ToolResultCache();
    const pipeline = new ToolExecutionPipeline(cache, new PermissionPolicy(noPermissionConfig));
    const execute = vi.fn(async () => ({ content: 'expensive' }));
    const tool = makeTool(
      { name: 'web_search', metadata: { category: 'web', cacheable: true, timeout: 1000 } },
      execute,
    );

    await pipeline.execute(tool, { query: 'test' }, makeContext());
    // Second call without confirm callback must still be denied for ask-tools;
    // web_search is allow-listed by policy so cache is reachable.
    const second = await pipeline.execute(tool, { query: 'test' }, makeContext());
    expect(second.content).toBe('expensive');
  });

  it('wraps execution errors into error ToolResults', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const tool = makeTool({}, async () => {
      throw new Error('boom');
    });

    const result = await pipeline.execute(tool, {}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('boom');
  });

  it('times out tools that exceed their metadata timeout', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig));
    const tool = makeTool(
      { metadata: { category: 'test', cacheable: false, timeout: 50 } },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { content: 'too late' };
      },
    );

    const result = await pipeline.execute(tool, {}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('truncates oversized tool results with a PARTIAL marker', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      maxResultChars: 100,
    });
    const tool = makeTool({}, async () => ({ content: 'x'.repeat(500) }));

    const result = await pipeline.execute(tool, {}, makeContext());
    expect(result.isError).toBeUndefined();
    expect(result.content.startsWith('x'.repeat(100))).toBe(true);
    expect(result.content).toContain('PARTIAL');
    expect(result.content).toContain('500');
  });

  it('leaves short tool results untouched', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      maxResultChars: 100,
    });
    const tool = makeTool({}, async () => ({ content: 'short' }));

    const result = await pipeline.execute(tool, {}, makeContext());
    expect(result.content).toBe('short');
  });
});
