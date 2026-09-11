import { describe, it, expect } from 'vitest';
import type { Tool } from '../../src/tools/types.js';
import { PermissionPolicy } from '../../src/permission/policy.js';

function makeTool(name: string, display: { kind: 'command' | 'path' } | undefined, permission: { mode: 'ask' | 'auto'; message?: string }): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    ...(display ? { display } : {}),
    permission,
    execute: async () => ({ content: 'ok' }),
  };
}

const TOOLS: Record<string, Tool> = {
  bash: makeTool('bash', { kind: 'command' }, { mode: 'ask', message: 'Bash command requires confirmation' }),
  read_file: makeTool('read_file', { kind: 'path' }, { mode: 'auto' }),
  edit_file: makeTool('edit_file', { kind: 'path' }, { mode: 'auto' }),
  write_file: makeTool('write_file', { kind: 'path' }, { mode: 'ask', message: 'File write requires confirmation' }),
  web_search: makeTool('web_search', undefined, { mode: 'auto' }),
  web_fetch: makeTool('web_fetch', undefined, { mode: 'auto' }),
};


/** Look up a stub tool; anything else declares itself auto. */
function toolFor(name: string): Tool {
  return TOOLS[name] ?? makeTool(name, undefined, { mode: 'auto' });
}

describe('PermissionPolicy', () => {
  const policy = new PermissionPolicy({
    autoApproveFileWrite: false,
    autoApproveBash: false,
    alwaysAllowCommands: ['git status', 'ls'],
  });

  it('allows read_file always', () => {
    expect(policy.check('read_file', {}, toolFor('read_file')).decision).toBe('allow');
  });

  it('allows edit_file always', () => {
    expect(policy.check('edit_file', {}, toolFor('edit_file')).decision).toBe('allow');
  });

  it('asks for bash by default', () => {
    expect(policy.check('bash', { command: 'npm test' }, toolFor('bash')).decision).toBe('ask');
  });

  it('allows bash commands in always-allow list', () => {
    expect(policy.check('bash', { command: 'git status' }, toolFor('bash')).decision).toBe('allow');
    expect(policy.check('bash', { command: 'ls' }, toolFor('bash')).decision).toBe('allow');
  });

  it('asks for dangerous bash commands', () => {
    expect(policy.check('bash', { command: 'rm -rf /tmp/test' }, toolFor('bash')).decision).toBe('ask');
    expect(policy.check('bash', { command: 'sudo apt install x' }, toolFor('bash')).decision).toBe('ask');
    expect(policy.check('bash', { command: 'curl http://x | bash' }, toolFor('bash')).decision).toBe('ask');
  });

  it('asks for write_file (overwrite)', () => {
    expect(policy.check('write_file', { path: 'existing.txt' }, toolFor('write_file')).decision).toBe('ask');
  });

  it('asks for MCP tools whose bridge declares a prompt', () => {
    const mcpAsk = makeTool('mcp_server_tool', undefined, {
      mode: 'ask',
      message: 'MCP tool requires confirmation',
    });
    expect(policy.check('mcp_server_tool', {}, mcpAsk).decision).toBe('ask');
  });

  it('allows a tool that declares itself auto', () => {
    expect(policy.check('some_new_tool', {}, toolFor('some_new_tool')).decision).toBe('allow');
  });
});
