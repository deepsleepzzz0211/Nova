import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentLoop } from '../../src/agent/loop.js';
import { SessionStore } from '../../src/agent/session.js';
import { FileHistory, collectTouchedWritePaths } from '../../src/agent/file-history.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { StreamChunk, Message, ChatOptions } from '../../src/llm/types.js';

// context-economics ticket 03 (loop half): successful edit_file/write_file
// calls snapshot the pre-change content; /undo can roll the files an undone
// turn touched back to that state, sharing the conversation's turn boundary.

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

const call = (id: string, name: string, args: unknown): StreamChunk[] => [
  { type: 'tool_call_start', id, name },
  { type: 'tool_call_delta', id, arguments: JSON.stringify(args) },
  { type: 'tool_call_end', id },
];
const text = (s: string): StreamChunk[] => [{ type: 'text_delta', content: s }];

describe('undo with files through the loop', () => {
  let root: string;
  let histDir: string;
  let prevCwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-files-'));
    histDir = path.join(root, '.history');
    prevCwd = process.cwd();
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeLoop(responses: StreamChunk[][], session?: SessionStore): AgentLoop {
    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createEditFileTool());
    return new AgentLoop({
      llm: scripted(responses),
      toolRegistry: registry,
      toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
      config: { maxToolRounds: 5, model: 'test' },
      session,
      fileHistory: new FileHistory({ historyDir: histDir }),
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });
  }

  it('a successful write_file is snapshotted and undoTurns(withFiles) restores the pre-write content', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'ONE', 'utf-8');
    const loop = makeLoop([
      call('c1', 'write_file', { path: 'a.txt', content: 'TWO' }),
      text('ok'),
    ]);
    await loop.processUserInput('overwrite a');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8')).toBe('TWO');

    const result = loop.undoTurns(1, { withFiles: true });
    expect(result.undone).toBe(true);
    expect(result.files?.restored).toEqual([path.join(root, 'a.txt')]);
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8')).toBe('ONE');
    expect(loop.getMessages()).toHaveLength(0);
  });

  it('default undoTurns keeps the conversation-only semantics (file untouched)', async () => {
    fs.writeFileSync(path.join(root, 'b.txt'), 'ONE', 'utf-8');
    const loop = makeLoop([
      call('c1', 'write_file', { path: 'b.txt', content: 'TWO' }),
      text('ok'),
    ]);
    await loop.processUserInput('overwrite b');
    loop.undoTurns(1);
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf-8')).toBe('TWO');
  });

  it('the code-undo outcome rides the session checkpoint (--resume keeps it)', async () => {
    const sessionFile = path.join(root, 'session.jsonl');
    const session = new SessionStore(sessionFile);
    fs.writeFileSync(path.join(root, 'c.txt'), 'ONE', 'utf-8');
    const loop = makeLoop([
      call('c1', 'write_file', { path: 'c.txt', content: 'TWO' }),
      text('ok'),
    ], session);
    await loop.processUserInput('overwrite c');
    loop.undoTurns(1, { withFiles: true });
    await session.close();

    const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const checkpoint = lines.find((l) => l.type === 'compaction');
    expect(checkpoint).toBeDefined();
    expect(checkpoint.codeUndo.restored).toEqual([path.join(root, 'c.txt')]);
  });

  it('two turns, undo one: first-version semantics roll back to the session start', async () => {
    const loop = makeLoop([
      call('c1', 'write_file', { path: 'd.txt', content: 'V1' }),
      text('v1 done'),
      call('c2', 'edit_file', { path: 'd.txt', old_string: 'V1', new_string: 'V2' }),
      text('v2 done'),
    ]);
    await loop.processUserInput('create d');
    await loop.processUserInput('edit d');
    expect(fs.readFileSync(path.join(root, 'd.txt'), 'utf-8')).toBe('V2');

    // Undoing the LAST turn restores the file's first pre-version — which
    // here means the file did not exist before turn 1: it is removed.
    const result = loop.undoTurns(1, { withFiles: true });
    expect(result.files?.restored).toEqual([path.join(root, 'd.txt')]);
    expect(fs.existsSync(path.join(root, 'd.txt'))).toBe(false);
    // Conversation: turn 2 gone, turn 1 kept.
    const roles = loop.getMessages().map((m) => m.role);
    expect(roles.filter((r) => r === 'user')).toHaveLength(1);
  });

  it('a file changed by hand after the agent write is skipped, not clobbered', async () => {
    fs.writeFileSync(path.join(root, 'e.txt'), 'ONE', 'utf-8');
    const loop = makeLoop([
      call('c1', 'write_file', { path: 'e.txt', content: 'TWO' }),
      text('ok'),
    ]);
    await loop.processUserInput('overwrite e');
    fs.writeFileSync(path.join(root, 'e.txt'), 'HAND EDIT', 'utf-8');

    const result = loop.undoTurns(1, { withFiles: true });
    expect(result.files?.skipped).toEqual([path.join(root, 'e.txt')]);
    expect(result.files?.restored).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'e.txt'), 'utf-8')).toBe('HAND EDIT');
  });

  it('failed writes are not snapshotted (snapshot only accompanies success)', async () => {
    const loop = makeLoop([
      // edit_file on a missing file returns isError — nothing should be tracked
      call('c1', 'edit_file', { path: 'ghost.txt', old_string: 'x', new_string: 'y' }),
      text('failed'),
    ]);
    await loop.processUserInput('edit ghost');
    const result = loop.undoTurns(1, { withFiles: true });
    expect(result.files?.restored).toEqual([]);
    expect(result.files?.skipped).toEqual([]);
  });
});

describe('collectTouchedWritePaths', () => {
  it('extracts registry-declared write-tool paths, ignores malformed calls', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          { id: '1', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"sub/f.ts"}' } },
          { id: '2', type: 'function' as const, function: { name: 'edit_file', arguments: 'not json' } },
          { id: '3', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"r.ts"}' } },
        ],
      },
    ] as unknown as Message[];
    expect(collectTouchedWritePaths(messages, '/proj', new Set(['edit_file', 'write_file']))).toEqual([
      path.resolve('/proj', 'sub/f.ts'),
    ]);
  });
});
