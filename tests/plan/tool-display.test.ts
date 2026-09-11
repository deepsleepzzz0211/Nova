import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import type { Tool } from '../../src/tools/types.js';
import { summarizeCall } from '../../src/tui/tool-summary.js';
import { describeCall, dangerReason } from '../../src/tui/permission-display.js';

function makeTool(name: string, display?: { kind: 'command' | 'path' }): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    ...(display ? { display } : {}),
    execute: async () => ({ content: 'ok' }),
  };
}

describe('tool display metadata in the registry (tui-refactor 14)', () => {
  describe('ToolRegistry.displayKindFor', () => {
    it('returns the declared display kind', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool('bash', { kind: 'command' }));
      registry.register(makeTool('read_file', { kind: 'path' }));
      registry.register(makeTool('web_search'));
      expect(registry.displayKindFor('bash')).toBe('command');
      expect(registry.displayKindFor('read_file')).toBe('path');
      expect(registry.displayKindFor('web_search')).toBeUndefined();
      expect(registry.displayKindFor('nope')).toBeUndefined();
    });
  });

  describe('summarizeCall with a registry resolver', () => {
    const kindOf = (name: string): 'command' | 'path' | undefined =>
      name === 'bash' ? 'command' : name === 'read_file' ? 'path' : undefined;

    it('shows the command for command tools', () => {
      expect(summarizeCall('bash', JSON.stringify({ command: 'ls -la' }), kindOf)).toBe('ls -la');
    });

    it('shows the path for registry-declared path tools (real tool names)', () => {
      expect(summarizeCall('read_file', JSON.stringify({ path: 'src/a.ts' }), kindOf)).toBe('src/a.ts');
    });

    it('falls back to compact JSON without a declared kind', () => {
      expect(summarizeCall('web_search', JSON.stringify({ query: 'x' }), kindOf)).toBe('{"query":"x"}');
    });

    it('falls back when no resolver is provided', () => {
      expect(summarizeCall('read_file', JSON.stringify({ path: 'a' }))).toBe('{"path":"a"}');
    });
  });

  describe('permission display with a registry resolver', () => {
    const kindOf = (name: string): 'command' | 'path' | undefined =>
      name === 'bash' ? 'command' : name === 'read_file' ? 'path' : undefined;

    it('describes path tools by path and command tools by command', () => {
      expect(describeCall('read_file', { path: 'a.ts' }, kindOf)).toBe('a.ts');
      expect(describeCall('bash', { command: 'ls' }, kindOf)).toBe('ls');
    });

    it('only applies danger patterns to command tools', () => {
      expect(dangerReason('bash', { command: 'rm -rf /x' }, kindOf)).toBe('Recursive file deletion');
      expect(dangerReason('read_file', { command: 'rm -rf /x' }, kindOf)).toBeNull();
    });
  });
});

describe('real tools declare their display kind (regression)', () => {
  it('bash=command, read/write/edit_file=path through the real factories', () => {
    const registry = new ToolRegistry();
    registry.register(createBashTool());
    registry.register(createReadFileTool());
    registry.register(createWriteFileTool());
    registry.register(createEditFileTool());

    expect(registry.displayKindFor('bash')).toBe('command');
    // The old hardcoded set used 'read'/'write'/'edit' and never matched
    // these real names — path summaries silently fell back to raw JSON.
    expect(registry.displayKindFor('read_file')).toBe('path');
    expect(registry.displayKindFor('write_file')).toBe('path');
    expect(registry.displayKindFor('edit_file')).toBe('path');
    expect(registry.displayKindFor('todo_write')).toBeUndefined();
  });
});
