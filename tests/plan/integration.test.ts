import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import { PermissionPolicy } from '../../src/permission/policy.js';

describe('Integration: all tools register and policy works', () => {
  it('registers all 6 built-in tools', () => {
    const reg = new ToolRegistry();
    reg.register(createReadFileTool());
    reg.register(createWriteFileTool());
    reg.register(createEditFileTool());
    reg.register(createBashTool());
    reg.register(createWebSearchTool());
    reg.register(createWebFetchTool());

    expect(reg.getAll()).toHaveLength(6);
    expect(reg.toToolDefinitions()).toHaveLength(6);
    expect(reg.get('read_file')).toBeDefined();
    expect(reg.get('bash')).toBeDefined();
  });

  it('policy correctly gates all tool types', () => {
    const policy = new PermissionPolicy({
      autoApproveFileWrite: false,
      autoApproveBash: false,
      alwaysAllowCommands: ['git status'],
    });

    expect(policy.check('read_file', {}).decision).toBe('allow');
    expect(policy.check('edit_file', {}).decision).toBe('allow');
    expect(policy.check('web_search', {}).decision).toBe('allow');
    expect(policy.check('web_fetch', {}).decision).toBe('allow');
    expect(policy.check('write_file', {}).decision).toBe('ask');
    expect(policy.check('bash', { command: 'npm test' }).decision).toBe('ask');
    expect(policy.check('bash', { command: 'git status' }).decision).toBe('allow');
    expect(policy.check('bash', { command: 'rm -rf /' }).decision).toBe('ask');
  });
});
