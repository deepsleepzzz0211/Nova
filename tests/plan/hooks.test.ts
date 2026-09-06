import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool, ToolContext, ToolResult } from '../../src/tools/types.js';
import type { PostToolUseHook, PreToolUseHook } from '../../src/hooks/types.js';

const noPermissionConfig = {
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
};

function makeTool(execute: (params: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    parameters: { type: 'object', properties: {} },
    execute,
  };
}

function makeContext(): ToolContext {
  return { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };
}

describe('Pipeline hooks', () => {
  it('pre hook can deny execution with a reason', async () => {
    const pre: PreToolUseHook = () => ({ deny: true, reason: 'blocked by policy hook' });
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { pre: [pre] },
    });
    const execute = vi.fn(async () => ({ content: 'ok' }));

    const result = await pipeline.execute(makeTool(execute), {}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('blocked by policy hook');
    expect(execute).not.toHaveBeenCalled();
  });

  it('pre hook allow (no deny) lets execution proceed', async () => {
    const pre: PreToolUseHook = () => undefined;
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { pre: [pre] },
    });

    const result = await pipeline.execute(makeTool(async () => ({ content: 'ran' })), {}, makeContext());
    expect(result.content).toBe('ran');
  });

  it('post hook observes tool name, params, and result', async () => {
    const post = vi.fn<PostToolUseHook>(async () => undefined);
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { post: [post] },
    });

    await pipeline.execute(makeTool(async () => ({ content: 'ran' })), { q: 1 }, makeContext());
    expect(post).toHaveBeenCalledWith({
      tool: 'test_tool',
      params: { q: 1 },
      result: { content: 'ran' },
    });
  });

  it('a throwing hook does not break execution', async () => {
    const pre: PreToolUseHook = () => {
      throw new Error('hook crashed');
    };
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { pre: [pre] },
    });

    const result = await pipeline.execute(makeTool(async () => ({ content: 'ran' })), {}, makeContext());
    expect(result.content).toBe('ran');
  });

  it('post hook failure does not change the result', async () => {
    const post: PostToolUseHook = async () => {
      throw new Error('post crashed');
    };
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy(noPermissionConfig), {
      hooks: { post: [post] },
    });

    const result = await pipeline.execute(makeTool(async () => ({ content: 'ran' })), {}, makeContext());
    expect(result.content).toBe('ran');
  });
});
