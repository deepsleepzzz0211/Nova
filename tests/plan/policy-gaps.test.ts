import { describe, it, expect } from 'vitest';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { SyncPermissionPolicy } from '../../src/permission/sync-policy.js';
import type { PermissionConfig } from '../../src/config/schema.js';

const config: PermissionConfig = {
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: ['git status', 'ls'],
};

describe.each([
  ['PermissionPolicy', new PermissionPolicy(config)],
  ['SyncPermissionPolicy', new SyncPermissionPolicy(config)],
])('%s boundary behaviors', (_name, policy) => {
  it('always-allow prefix must not match longer commands (separator enforced)', () => {
    // 'git statusx' starts with 'git status' — must NOT be allowed
    expect(policy.check('bash', { command: 'git statusx' }).decision).toBe('ask');
    expect(policy.check('bash', { command: 'lsx' }).decision).toBe('ask');
    // But exact match and prefix+space match are allowed
    expect(policy.check('bash', { command: 'ls -la' }).decision).toBe('allow');
    expect(policy.check('bash', { command: 'git status --short' }).decision).toBe('allow');
  });

  it('dangerous detection runs even for always-allowed prefixes? no — always-allow wins first', () => {
    // 'git status' is allowed before dangerous check
    expect(policy.check('bash', { command: 'git status' }).decision).toBe('allow');
  });

  it('dangerous pattern sets the specific message', () => {
    const decision = policy.check('bash', { command: 'sudo apt install x' });
    expect(decision.decision).toBe('ask');
    expect(decision.message).toBe('Dangerous command detected: Elevated privileges');
  });

  it('non-string command param is treated as no command', () => {
    expect(policy.check('bash', { command: 123 }).decision).toBe('ask'); // falls to bash default
    expect(policy.check('bash', {}).decision).toBe('ask');
  });

  it('bash default ask message is specific', () => {
    expect(policy.check('bash', { command: 'npm test' }).message).toBe('Bash command requires confirmation');
  });

  it('write_file ask message is specific', () => {
    expect(policy.check('write_file', { path: 'a' }).message).toBe('File write requires confirmation');
  });

  it('mcp_ prefix check matches tools with prefix anywhere in name start', () => {
    expect(policy.check('mcp_fs_read', {}).decision).toBe('ask');
    expect(policy.check('my_tool', {}).decision).toBe('allow');
  });
});
