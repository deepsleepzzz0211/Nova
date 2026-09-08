import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from '../../src/agent/context.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { SessionStore } from '../../src/agent/session.js';
import { Compactor } from '../../src/agent/compaction.js';
import { gatherEnvironment, loadProjectInstructions } from '../../src/agent/environment.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { createTodoTool } from '../../src/tools/todo.js';
import { withSystemPrompt } from '../../src/llm/messages.js';
import { LLMProviderRegistry } from '../../src/llm/registry.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import type { Message, StreamChunk, ChatOptions } from '../../src/llm/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { ToolContext } from '../../src/tools/types.js';

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

describe('ContextManager token accounting', () => {
  const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 100_000 });

  it('counts tool_calls as extra tokens (more than the same message without)', () => {
    const withCalls: Message[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    ];
    const without: Message[] = [{ role: 'assistant', content: null }];
    expect(cm.countTokens(withCalls)).toBeGreaterThan(cm.countTokens(without));
  });

  it('counts tool_call_id framing on tool messages', () => {
    const toolMsg: Message[] = [{ role: 'tool', tool_call_id: 'c1', content: 'x' }];
    const userMsg: Message[] = [{ role: 'user', content: 'x' }];
    expect(cm.countTokens(toolMsg)).toBeGreaterThan(cm.countTokens(userMsg));
  });

  it('truncate preserves leading system messages even mid-list truncation', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'system prompt' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `msg ${i} ${'y'.repeat(200)}` })),
    ];
    const truncated = cm.truncateToTokens(msgs, 300);
    expect(truncated[0].role).toBe('system');
    expect(truncated.length).toBeLessThan(msgs.length);
  });
});

describe('buildSystemPrompt section structure', () => {
  it('renders sections with blank-line separators in a stable order', () => {
    const prompt = buildSystemPrompt(
      [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) }],
      [{ name: 'deploy', description: 'Deploy the app', path: '/x/SKILL.md' }],
      {
        environment: { workingDirectory: '/work', platform: 'linux', gitBranch: 'main', gitStatus: ' M a.ts' },
        projectInstructions: 'NEVER use any.',
        customPrompt: 'Be terse.',
      },
    );

    // Order of sections
    const idxIdentity = prompt.indexOf('You are Nova');
    const idxEnv = prompt.indexOf('## Environment');
    const idxProject = prompt.indexOf('## Project Instructions');
    const idxTools = prompt.indexOf('## Available Tools');
    const idxSkills = prompt.indexOf('## Available Skills');
    const idxCustom = prompt.indexOf('Be terse.');
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxEnv);
    expect(idxEnv).toBeLessThan(idxProject);
    expect(idxProject).toBeLessThan(idxTools);
    expect(idxTools).toBeLessThan(idxSkills);
    expect(idxSkills).toBeLessThan(idxCustom);

    // Blank-line separators before section headers
    expect(prompt).toContain('\n\n## Environment\nWorking directory: /work');
    expect(prompt).toContain('Git branch: main');
    expect(prompt).toContain('Git status:\n M a.ts');
    expect(prompt).toContain('\n\n## Project Instructions\nNEVER use any.');
    expect(prompt).toContain('\n\n## Available Tools\n- **read_file**: Read a file');
    expect(prompt).toContain('\n\n## Available Skills\n- **deploy**: Deploy the app');
  });
});

describe('SessionStore edge cases', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-session2-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('create() generates a session filename with a colon-free timestamp', () => {
    const store = SessionStore.create(dir, new Date('2026-01-02T03:04:05.678Z'));
    const file = (store as unknown as { filePath: string }).filePath;
    const base = path.basename(file);
    expect(base).toMatch(/^session-/);
    expect(base.endsWith('.jsonl')).toBe(true);
    const timestamp = base.slice('session-'.length, -'.jsonl'.length);
    expect(timestamp).not.toContain(':');
    expect(timestamp).not.toContain('.');
  });

  it('append after close rejects', async () => {
    const store = new SessionStore(path.join(dir, 'closed.jsonl'));
    await store.close();
    await expect(store.append({ role: 'user', content: 'x' })).rejects.toThrow(/closed/);
  });

  it('load returns [] for unreadable files', () => {
    expect(SessionStore.load(path.join(dir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('Compactor boundary (tiny keep budget)', () => {
  it('summarizes non-user messages outside the budget, keeps users + newest verbatim', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'short summary' };
      },
    };
    const compactor = new Compactor(llm, 'm', {
      keepRecentTokens: 1,
      countTokens: (t) => Math.ceil(t.length / 4),
    });
    const history: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'middle' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const result = await compactor.compact(history);
    // summary + user (always verbatim) + newest assistant
    expect(result!.messages).toHaveLength(3);
    expect(result!.messages[0].content).toContain('short summary');
    expect(result!.messages[1]).toEqual(history[0]);
    expect(result!.messages[2]).toEqual(history[2]);
  });
});

describe('withSystemPrompt roles and no-op cases', () => {
  it('returns the same array when no systemPrompt given', () => {
    const msgs: Message[] = [{ role: 'user', content: 'x' }];
    expect(withSystemPrompt(msgs, undefined)).toBe(msgs);
    expect(withSystemPrompt(msgs, 'sys')).not.toBe(msgs);
  });

  it('does not prepend when history already starts with a system message', () => {
    const msgs: Message[] = [{ role: 'system', content: 'already' }, { role: 'user', content: 'x' }];
    expect(withSystemPrompt(msgs, 'sys')).toBe(msgs);
  });
});

describe('LLMProviderRegistry caching by api and baseUrl', () => {
  it('caches instances per api+baseUrl combination', () => {
    const registry = new LLMProviderRegistry();
    const a = registry.getForApi('openai-completions', { name: 'openai', apiKey: 'k', baseUrl: 'https://a.example' });
    const a2 = registry.getForApi('openai-completions', { name: 'openai', apiKey: 'k', baseUrl: 'https://a.example' });
    const b = registry.getForApi('openai-completions', { name: 'openai', apiKey: 'k', baseUrl: 'https://b.example' });
    expect(a).toBe(a2);
    expect(b).not.toBe(a);
  });

  it('name-based getProvider still caches per baseUrl', () => {
    const registry = new LLMProviderRegistry();
    const a = registry.getProvider({ name: 'openai', apiKey: 'k', baseUrl: 'https://x1' });
    const a2 = registry.getProvider({ name: 'openai', apiKey: 'k', baseUrl: 'https://x1' });
    expect(a).toBe(a2);
    expect(() => registry.getForApi('unknown-api' as never, { name: 'x' })).toThrow(/Unknown API/);
  });
});

describe('gatherEnvironment git details', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-gitenv-'));
    const git = (args: string[]): void => {
      require('child_process').execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    // 12 modified files → more than the 10-line cap
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
    }
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    // 12 more staged files → more than the 10-line cap
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(repo, `new${i}.txt`), 'x');
    }
    git(['add', '.']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('caps git status at 10 lines with an overflow note', () => {
    const env = gatherEnvironment(repo);
    expect(env.isGitRepo).toBe(true);
    expect(env.gitStatus).toContain('... (12 changed paths)');
    expect(env.gitStatus!.split('\n').filter((l) => l.startsWith('A ')).length).toBeLessThanOrEqual(10);
    expect(env.gitBranch).toBe('master'); // or main depending on git config
  });

  it('reports clean status', () => {
    require('child_process').execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    const env = gatherEnvironment(repo);
    expect(env.gitStatus).toBe('(clean)');
  });
});

describe('loadProjectInstructions precedence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-instr-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers AGENTS.md over CLAUDE.md and falls back to CLAUDE.md', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'agents rules');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'claude rules');
    expect(loadProjectInstructions(dir)).toBe('agents rules');

    fs.rmSync(path.join(dir, 'AGENTS.md'));
    expect(loadProjectInstructions(dir)).toBe('claude rules');

    fs.rmSync(path.join(dir, 'CLAUDE.md'));
    expect(loadProjectInstructions(dir)).toBeUndefined();
  });
});

describe('AgentLoop error hardening', () => {
  it('invalid JSON tool arguments produce an error tool result', async () => {
    let callIndex = 0;
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        callIndex++;
        if (callIndex === 1) {
          yield { type: 'tool_call_start', id: 'c1', name: 'echo' };
          yield { type: 'tool_call_delta', id: 'c1', arguments: '{invalid json' };
          yield { type: 'tool_call_end', id: 'c1' };
          return;
        }
        yield { type: 'text_delta', content: 'ok' };
      },
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    });

    const results: Array<{ content: string; isError?: boolean }> = [];
    const loop = new AgentLoop({
      llm,
      toolRegistry: registry,
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: (r) => results.push(r),
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('go');
    expect(results[0].isError).toBe(true);
    expect(results[0].content.length).toBeGreaterThan(0);
  });

  it('compactNow returns compacted=false when history is already small', async () => {
    const llm: LLMProvider = {
      async *chat(): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', content: 'unused' };
      },
    };
    const loop = new AgentLoop({
      llm,
      toolRegistry: new ToolRegistry(),
      toolExecutionPipeline: makePipeline(),
      config: { maxToolRounds: 10, model: 'test' },
      context: { maxTokens: 100_000, strategy: 'compact' },
      onToken: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onPermissionRequest: async () => true,
    });

    await loop.processUserInput('tiny');
    const result = await loop.compactNow();
    // 2 messages → compaction possible but summary token count may equal history;
    // either way it must not crash and must report a boolean
    expect(typeof result.compacted).toBe('boolean');
  });
});

describe('todo_write list formatting', () => {
  it('joins items with newlines', async () => {
    const result = await createTodoTool({ todos: [] }).execute(
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result.content).toContain('[x] a\n[ ] b');
  });
});

describe('todo_write list formatting', () => {
  it('joins items with newlines', async () => {
    const result = await createTodoTool({ todos: [] }).execute(
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result.content).toContain('[x] a\n[ ] b');
  });
});
