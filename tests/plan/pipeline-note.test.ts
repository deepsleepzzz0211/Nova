import { describe, it, expect } from 'vitest';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Tool, ToolContext } from '../../src/tools/types.js';

// Batch-B ticket 03: a post-tool-use hook's note is appended to the tool
// result so the model can react (expand of the observation-only contract).

const policy = new PermissionPolicy({ autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [] });
const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

function autoTool(): Tool {
  return {
    name: 'write_file',
    description: '',
    parameters: { type: 'object', properties: {} },
    permission: { mode: 'auto' },
    async execute() {
      return { content: 'File written: a.txt' };
    },
  };
}

describe('post-tool-use notes', () => {
  it('appends a hook note to the result content', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), policy, {
      hooks: { post: [async () => ({ note: 'lint: 2 errors' })] },
    });
    const result = await pipeline.execute(autoTool(), {}, ctx);
    expect(result.content).toContain('File written: a.txt');
    expect(result.content).toMatch(/\[post-tool-use write_file\] lint: 2 errors/);
  });

  it('no note = untouched content; crashing hook never alters the result', async () => {
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), policy, {
      hooks: { post: [async () => { throw new Error('boom'); }, async () => ({})] },
    });
    const result = await pipeline.execute(autoTool(), {}, ctx);
    expect(result.content).toBe('File written: a.txt');
    expect(result.isError).toBeUndefined();
  });

  it('error results are annotated too (a failed write plus lint context matters)', async () => {
    const failing: Tool = {
      ...autoTool(),
      async execute() {
        return { content: 'write failed: EACCES', isError: true };
      },
    };
    const pipeline = new ToolExecutionPipeline(new ToolResultCache(), policy, {
      hooks: { post: [async () => ({ note: 'permissions drift detected' })] },
    });
    const result = await pipeline.execute(failing, {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('permissions drift detected');
  });
});
