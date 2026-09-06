import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
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

describe('AgentLoop skill injection (progressive disclosure)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-skills-loop-'));
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

  it('injects matched skill bodies into the system prompt for the matching turn', async () => {
    const registry = new SkillRegistry();
    await registry.scan(tmp);

    const calls: ChatOptions[] = [];
    const llm: LLMProvider = {
      async *chat(_msgs: Message[], opts: ChatOptions): AsyncIterable<StreamChunk> {
        calls.push(opts);
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

    // Matching request → skill body injected
    await loop.processUserInput('help me debug these bugs');
    expect(calls[0].systemPrompt).toContain('Read the stack trace first.');
    expect(calls[0].systemPrompt).toContain('## Active Skills');

    // Non-matching request → only the one-line listing, no body
    await loop.processUserInput('what is the weather');
    expect(calls[1].systemPrompt).not.toContain('Read the stack trace first.');
    expect(calls[1].systemPrompt).toContain('**debugging**: Use when debugging bugs and errors');
  });
});
