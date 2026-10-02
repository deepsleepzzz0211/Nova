import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { DirectoryInstructions } from '../../src/agent/directory-instructions.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

// context-economics ticket 02 (loop half): touching a file through the
// read/edit/write tools injects the not-yet-seen directory instructions as
// APPEND-ONLY system messages after the tool result — the frozen system
// prompt and all prior messages keep their bytes (cache discipline).

const policy = new PermissionPolicy({ autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [] });

function scripted(responses: StreamChunk[][]): LLMProvider {
  let i = 0;
  return {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(_msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
      for (const c of responses[i++] ?? []) yield c;
    },
  };
}

const call = (id: string, name: string, args: string): StreamChunk[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_delta', id, arguments: args },
  { type: 'tool_call_end', id },
];

describe('directory instruction injection through the loop', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirinject-'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'AGENTS.md'), 'SUB RULES');
    fs.writeFileSync(path.join(root, 'sub', 'f.ts'), 'const x = 1;\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makeLoop(dirs: DirectoryInstructions) {
    const registry = new ToolRegistry();
    registry.register(createReadFileTool());
    const llm = scripted([
      call('c1', 'read_file', JSON.stringify({ path: path.join(root, 'sub', 'f.ts') })),
      call('c2', 'read_file', JSON.stringify({ path: path.join(root, 'sub', 'f.ts') })),
      [{ type: 'text_delta', content: 'done' }],
    ]);
    return new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 5, model: 'test' },
      directoryInstructions: dirs,
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
  }

  it('injects once after the first read; second read injects nothing', async () => {
    const dirs = new DirectoryInstructions({ rootDir: root });
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const loop = makeLoop(dirs);
      await loop.processUserInput('read it');
      const injected = loop
        .getMessages()
        .filter((m) => m.role === 'system' && String(m.content).includes('SUB RULES'));
      expect(injected).toHaveLength(1);
      // Position: right after the first tool result, before the next assistant round.
      const roles = loop.getMessages().map((m) => m.role);
      const sysAt = roles.indexOf('system', 2);
      const toolAt = roles.indexOf('tool');
      const assistantAfter = roles.findIndex((r, idx) => r === 'assistant' && idx > toolAt);
      expect(sysAt).toBeGreaterThan(toolAt);
      expect(sysAt).toBeLessThan(assistantAfter);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('frozen prefix untouched: the live array still starts with the user turn (no head insertion)', async () => {
    const dirs = new DirectoryInstructions({ rootDir: root });
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      const loop = makeLoop(dirs);
      await loop.processUserInput('read it');
      const msgs = loop.getMessages();
      expect(msgs[0].role).toBe('user');
      expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1); // only the injection
    } finally {
      process.chdir(prevCwd);
    }
  });
});
