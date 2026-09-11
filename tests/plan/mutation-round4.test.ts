/**
 * Mutation round 4 — survivor-cluster targeting (Stryker analysis 72.46%).
 * Each describe targets a surviving-mutant cluster surfaced by
 * reports/mutation/mutation.json.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isContextOverflowError } from '../../src/llm/errors.js';
import { ContextManager } from '../../src/agent/context.js';
import { SessionStore } from '../../src/agent/session.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { Message } from '../../src/llm/types.js';

import type { Tool } from '../../src/tools/types.js';

function stub(name: string, permission: { mode: 'ask' | 'auto'; message?: string }, display?: { kind: 'command' | 'path' }): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    ...(display ? { display } : {}),
    permission,
    execute: async () => ({ content: 'ok' }),
  };
}

const BASH = stub('bash', { mode: 'ask', message: 'Bash command requires confirmation' }, { kind: 'command' });
const READ_FILE = stub('read_file', { mode: 'auto' });
const EDIT_FILE = stub('edit_file', { mode: 'auto' });
const WEB_SEARCH = stub('web_search', { mode: 'auto' });
const WEB_FETCH = stub('web_fetch', { mode: 'auto' });
const WRITE_FILE = stub('write_file', { mode: 'ask', message: 'File write requires confirmation' });
const TODO_WRITE = stub('todo_write', { mode: 'auto' });
const MCP_TOOL = stub('mcp_server_tool', { mode: 'ask', message: 'MCP tool requires confirmation' });

describe('overflow error patterns (llm/errors.ts)', () => {
  const cases: Array<[string, string]> = [
    ['maximum context length', "This model's maximum context length is 128000 tokens"],
    ['context_length_exceeded', 'error code: context_length_exceeded'],
    ['context length exceeded', 'Request failed: context length exceeded'],
    ['prompt is too long', 'Your prompt is too long: 250000 tokens > 200000 maximum'],
    ['request exceeds the maximum allowed', 'The request exceeds the maximum allowed tokens'],
    ['input length exceeds', 'input length exceeds the configured maximum'],
    ['conversation exceeds the context window', 'the conversation exceeds the context window'],
    ['too many input tokens', 'Error: too many input tokens for this model'],
  ];
  for (const [pattern, message] of cases) {
    it(`recognizes "${pattern}"`, () => {
      expect(isContextOverflowError(new Error(message))).toBe(true);
    });
  }

  it('rejects non-overflow errors', () => {
    for (const message of [
      '401 Unauthorized: invalid api key',
      '429 rate limit exceeded',
      'socket hang up',
      'connection refused',
    ]) {
      expect(isContextOverflowError(new Error(message))).toBe(false);
    }
    expect(isContextOverflowError('plain string overflow about maximum context length')).toBe(true);
    expect(isContextOverflowError('')).toBe(false);
  });
});

describe('ContextManager counting & clamp boundaries', () => {
  it('counts framing overhead exactly (tool_call_id adds 4)', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 200_000 });
    const base: Message[] = [{ role: 'assistant', content: 'hello world' }];
    const withId: Message[] = [{ ...base[0], tool_call_id: 'c1' }];
    // tool_call_id adds exactly +4 to the framing
    expect(cm.countTokens(withId) - cm.countTokens(base)).toBe(4);
  });

  it('clamps odd windows to floor(maxTokens/2)', () => {
    // 101/2 = 50 → reserve clamped to 50, trigger 51
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 101 });
    expect(cm.triggerTokens).toBe(51);
  });
});

describe('SessionStore edge cases', () => {
  it('create() names files session-<sanitized-ISO>.jsonl', () => {
    const store = SessionStore.create('/tmp/whatever', new Date('2026-09-08T01:02:03.456Z'));
    // colons and dots sanitized out of the ISO timestamp
    expect(store['filePath']).toMatch(/session-2026-09-08T01-02-03-456Z\.jsonl$/);
  });

  it('appending after close() rejects', async () => {
    const store = SessionStore.create('/tmp/whatever');
    await store.close();
    await expect(store.append({ role: 'user', content: 'x' })).rejects.toThrow('SessionStore is closed');
  });

  it('load skips whitespace-only lines', () => {
    // write via constructor-adjacent path: build a file manually
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-load-'));
    const file = path.join(dir, 'ws.jsonl');
    fs.writeFileSync(file, '   \n\n{"role":"user","content":"ok"}\n   \n');
    expect(SessionStore.load(file)).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('sweep boundary: 29-day-old file kept, 31-day-old removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sweep-b-'));
    const keep = path.join(dir, 'session-29d.jsonl');
    const drop = path.join(dir, 'session-31d.jsonl');
    fs.writeFileSync(keep, '{}\n');
    fs.writeFileSync(drop, '{}\n');
    const d29 = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const d31 = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(keep, d29, d29);
    fs.utimesSync(drop, d31, d31);
    expect(SessionStore.sweep(dir, 30)).toBe(1);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(drop)).toBe(false);
  });

  it('listSummaries falls back to "(no user messages)" when history has none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-nouser-'));
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), '{"role":"assistant","content":"only assistant talk"}\n');
    const list = SessionStore.listSummaries(dir);
    expect(list).toHaveLength(1);
    expect(list[0].preview).toBe('(no user messages)');
  });
});

describe('PermissionPolicy rule details', () => {
  const mkPolicyWithAllows = (alwaysAllow: string[]) =>
    new PermissionPolicy({
      autoApproveFileWrite: false,
      autoApproveBash: false,
      alwaysAllowCommands: alwaysAllow,
    });

  it('always-allow matches whole command or prefix with a space — not bare prefixes', () => {
    const policy = mkPolicyWithAllows(['ls']);
    // exact match → allow
    expect(policy.check('bash', { command: 'ls' }, BASH).decision).toBe('allow');
    // prefix with space → allow
    expect(policy.check('bash', { command: 'ls -la src' }, BASH).decision).toBe('allow');
    // bare-prefix trap: lsof must NOT be always-allowed by the 'ls' entry
    expect(policy.check('bash', { command: 'lsof -i' }, BASH).decision).toBe('ask');
  });

  it('dangerous bash commands ask with the detection message', () => {
    const policy = mkPolicyWithAllows([]);
    const d = policy.check('bash', { command: 'rm -rf /' }, BASH);
    expect(d.decision).toBe('ask');
    expect(d.message).toContain('Dangerous command detected');
  });

  it('read-only tool set allows each member', () => {
    const policy = mkPolicyWithAllows([]);
    const byName: Record<string, Tool> = {
      read_file: READ_FILE,
      edit_file: EDIT_FILE,
      web_search: WEB_SEARCH,
      web_fetch: WEB_FETCH,
    };
    for (const tool of ['read_file', 'edit_file', 'web_search', 'web_fetch']) {
      expect(policy.check(tool, {}, byName[tool]).decision).toBe('allow');
    }
    expect(policy.check('write_file', {}, WRITE_FILE).decision).toBe('ask');
    expect(policy.check('mcp_server_tool', {}, MCP_TOOL).decision).toBe('ask');
    // Non-bash, non-MCP, non-listed → allow (default)
    expect(policy.check('todo_write', {}, TODO_WRITE).decision).toBe('allow');
  });

  it('non-string command params never hit bash rules', () => {
    const policy = mkPolicyWithAllows(['ls']);
    // command not a string → falls through to the bash ask rule
    expect(policy.check('bash', { command: 123 }, BASH).decision).toBe('ask');
  });
});

describe('system prompt assembly (prompt.ts)', () => {
  it('identity, environment, instructions, memory, tools, skills, custom in order', () => {
    const prompt = buildSystemPrompt(
      [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: '' }) }],
      [{ name: 'deploy', description: 'Deploy skill', path: '/p' }],
      {
        environment: { workingDirectory: '/work', platform: 'win32', gitBranch: 'main', gitStatus: 'M README.md' },
        projectInstructions: 'Use pnpm.',
        memory: '- remember this',
        customPrompt: 'Extra rules.',
      },
    );
    // Identity sentences present verbatim
    expect(prompt).toContain('You are Nova, an expert coding agent');
    expect(prompt).toContain('Work methodically');
    expect(prompt).toContain('todo_write tool to track multi-step work');
    // Environment details rendered
    expect(prompt).toContain('Working directory: /work');
    expect(prompt).toContain('Platform: win32');
    expect(prompt).toContain('Git branch: main');
    expect(prompt).toContain('Git status:\nM README.md');
    // Sections present
    expect(prompt).toContain('## Project Instructions');
    expect(prompt).toContain('Use pnpm.');
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('- **read_file**: Read a file');
    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('deploy');
    expect(prompt).toContain('Extra rules.');
    // Section ordering
    const order = ['## Environment', '## Project Instructions', '## Memory', '## Available Tools', '## Available Skills'].map((s) => prompt.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('omits optional sections and git fields when absent', () => {
    const prompt = buildSystemPrompt([], [], {});
    expect(prompt).not.toContain('## Environment');
    expect(prompt).not.toContain('## Project Instructions');
    expect(prompt).not.toContain('## Memory');
    expect(prompt).not.toContain('## Available Tools');
    expect(prompt).not.toContain('## Available Skills');
  });
});
