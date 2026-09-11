import { describe, it, expect } from 'vitest';
import type { Tool } from '../../src/tools/types.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { PermissionConfig } from '../../src/config/schema.js';

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

const config: PermissionConfig = {
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: ['git status', 'ls'],
};

describe('PermissionPolicy boundary behaviors', () => {
  const policy = new PermissionPolicy(config);
  it('always-allow prefix must not match longer commands (separator enforced)', () => {
    // 'git statusx' starts with 'git status' — must NOT be allowed
    expect(policy.check('bash', { command: 'git statusx' }, toolFor('bash')).decision).toBe('ask');
    expect(policy.check('bash', { command: 'lsx' }, toolFor('bash')).decision).toBe('ask');
    // But exact match and prefix+space match are allowed
    expect(policy.check('bash', { command: 'ls -la' }, toolFor('bash')).decision).toBe('allow');
    expect(policy.check('bash', { command: 'git status --short' }, toolFor('bash')).decision).toBe('allow');
  });

  it('dangerous detection runs even for always-allowed prefixes? no — always-allow wins first', () => {
    // 'git status' is allowed before dangerous check
    expect(policy.check('bash', { command: 'git status' }, toolFor('bash')).decision).toBe('allow');
  });

  it('dangerous pattern sets the specific message', () => {
    const decision = policy.check('bash', { command: 'sudo apt install x' }, toolFor('bash'));
    expect(decision.decision).toBe('ask');
    expect(decision.message).toBe('Dangerous command detected: Elevated privileges');
  });

  it('non-string command param is treated as no command', () => {
    expect(policy.check('bash', { command: 123 }, toolFor('bash')).decision).toBe('ask'); // falls to bash default
    expect(policy.check('bash', {}, toolFor('bash')).decision).toBe('ask');
  });

  it('bash default ask message is specific', () => {
    expect(policy.check('bash', { command: 'npm test' }, toolFor('bash')).message).toBe('Bash command requires confirmation');
  });

  it('write_file ask message is specific', () => {
    expect(policy.check('write_file', { path: 'a' }, toolFor('write_file')).message).toBe('File write requires confirmation');
  });

  it('an mcp tool is gated by its bridge declaration, not by its name', () => {
    const autoTool = makeTool('mcp_fs_read', undefined, { mode: 'auto' });
    const askTool = makeTool('mcp_fs_write', undefined, { mode: 'ask', message: 'MCP tool requires confirmation' });
    expect(policy.check('mcp_fs_read', {}, autoTool).decision).toBe('allow');
    expect(policy.check('mcp_fs_write', {}, askTool).decision).toBe('ask');
  });

  it('fails closed when a tool declares nothing', () => {
    const undeclared: Tool = {
      name: 'mystery_tool',
      description: 'no declaration',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    };
    const decision = policy.check('mystery_tool', {}, undeclared);
    expect(decision.decision).toBe('ask');
    expect(decision.message).toContain('declares no permission requirement');
  });

  it('fails closed when the tool is not provided at all', () => {
    expect(policy.check('mystery_tool', {}).decision).toBe('ask');
    expect(policy.check('mystery_tool', {}).message).toContain('no declared permission');
  });
});
