import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import type { ApprovalOutcome } from '../../src/tools/execution-pipeline.js';
import type { Tool, ToolResult } from '../../src/tools/types.js';
import { createBashTool } from '../../src/tools/bash.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import * as os from 'node:os';

/**
 * Ticket zcode-borrow 08 — approval can only narrow. A tool's prepareApproval
 * hook may add a preview or escalate ask→deny but its return type cannot
 * express "auto-approve"; and when the user edits the arguments during
 * approval, the edited input is re-run through the permission policy.
 */

const tmpCache = () => new ToolResultCache();
const policy = (over: Partial<{ allow: string[] }> = {}) =>
  new PermissionPolicy({
    autoApproveFileWrite: false,
    autoApproveBash: false,
    alwaysAllowCommands: over.allow ?? [],
  });

function askTool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'run',
    description: 'run a command',
    permission: { mode: 'ask', message: 'confirm run' },
    display: { kind: 'command' },
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async (params): Promise<ToolResult> => ({ content: `ran:${params.command}` }),
    ...over,
  };
}

const ctx = { workingDirectory: os.tmpdir(), abortSignal: new AbortController().signal };

describe('prepareApproval is narrow-only', () => {
  it('can escalate ask→deny (block) and the call does not execute', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool({
      prepareApproval: () => ({ block: true, previewNote: 'I refuse this one' }),
    });
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({ approved: true }));
    const result = await pipeline.execute(tool, { command: 'ls' }, ctx, { confirm });
    expect(result.isError).toBe(true);
    expect(confirm).not.toHaveBeenCalled(); // blocked before the user was asked
  });

  it('can attach a preview note that reaches the confirmation prompt', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool({ prepareApproval: () => ({ previewNote: 'about to run: ls -la' }) });
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({ approved: true }));
    await pipeline.execute(tool, { command: 'ls -la' }, ctx, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    const messageArg = confirm.mock.calls[0]?.[2] as string;
    expect(messageArg).toContain('about to run: ls -la');
    // the policy's own message is preserved too
    expect(messageArg).toContain('confirm run');
  });
});

describe('approval edits are re-checked', () => {
  it('edited params that are still an ask are re-confirmed, then run with edits', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool();
    let n = 0;
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => {
      n++;
      // First prompt: user edits the command; second prompt (re-check): accept.
      return n === 1 ? { approved: true, params: { command: 'rm -rf /' } } : { approved: true };
    });
    const result = await pipeline.execute(tool, { command: 'echo hi' }, ctx, { confirm });
    expect(confirm).toHaveBeenCalledTimes(2); // the edit forced a re-ask (dangerous)
    expect(result.content).toBe('ran:rm -rf /'); // executed with the edited input
  });

  it('edited params that the policy auto-allows skip the re-ask', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy({ allow: ['echo'] }));
    // Tool is dangerous-mode ask, but the edited command matches the allow list.
    const tool = askTool();
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({
      approved: true,
      params: { command: 'echo safe' },
    }));
    const result = await pipeline.execute(tool, { command: 'original' }, ctx, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1); // re-check resolved to allow, no second ask
    expect(result.content).toBe('ran:echo safe');
  });

  it('an edit that the policy auto-allows still cannot escape the tool block', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy({ allow: ['echo'] }));
    // prepareApproval refuses 'echo evil' even though the policy would allow it.
    const tool = askTool({
      prepareApproval: (params) => (params.command === 'echo evil' ? { block: true } : {}),
    });
    const executed: string[] = [];
    tool.execute = async (params) => {
      executed.push(String(params.command));
      return { content: `ran:${params.command}` };
    };
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({
      approved: true,
      params: { command: 'echo evil' },
    }));
    const result = await pipeline.execute(tool, { command: 'original' }, ctx, { confirm });
    expect(result.isError).toBe(true);
    expect(executed).toEqual([]); // the allowed-but-blocked edit never ran
  });

  it('edited params that resolve to deny are refused', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool({
      // a custom policy path: deny the edited command via a hook the next check
      prepareApproval: (params) => (params.command === 'forbidden' ? { block: true } : {}),
    });
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({
      approved: true,
      params: { command: 'forbidden' },
    }));
    const result = await pipeline.execute(tool, { command: 'ok' }, ctx, { confirm });
    expect(result.isError).toBe(true); // blocked by the tool's own narrowing hook
    expect(result.content).not.toContain('ran:');
  });

  it('unchanged params are NOT re-confirmed (single prompt)', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool();
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({ approved: true }));
    const result = await pipeline.execute(tool, { command: 'whoami' }, ctx, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('ran:whoami');
  });

  it('a plain boolean confirm result keeps the old behavior (no re-check)', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const tool = askTool();
    const confirm = vi.fn(async () => true); // legacy boolean contract
    const result = await pipeline.execute(tool, { command: 'whoami' }, ctx, { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('ran:whoami');
  });
});

describe('built-in bash preview hook', () => {
  it('surfaces the exact command in the confirmation prompt (preview-only)', async () => {
    const bash = createBashTool();
    expect(typeof bash.prepareApproval).toBe('function');
    const narrow = await bash.prepareApproval!({ command: 'git status' }, ctx);
    expect(narrow.previewNote).toContain('git status');
    // narrow-only contract: the hook result can never carry an approval bit
    expect(narrow).not.toHaveProperty('approved');
    expect(narrow.block == null).toBe(true);
  });

  it('the preview reaches the confirm message through the pipeline for bash', async () => {
    const pipeline = new ToolExecutionPipeline(tmpCache(), policy());
    const bash = createBashTool();
    const confirm = vi.fn(async (): Promise<ApprovalOutcome> => ({ approved: false }));
    await pipeline.execute(bash, { command: 'echo previewed' }, ctx, { confirm });
    const message = confirm.mock.calls[0]?.[2] as string;
    expect(message).toContain('Run: echo previewed');
  });
});
