import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createGrepTool } from '../../src/tools/grep.js';
import { createGlobTool } from '../../src/tools/glob.js';
import { createListDirTool } from '../../src/tools/list-dir.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import { createTodoTool } from '../../src/tools/todo.js';
import { createMemoryTool } from '../../src/memory/store.js';

// Search-tools batch closeout (ticket 04): the registry-level inventory the
// system prompt is built from. Names + auto-permission + deterministic order
// are the cache-prefix contract for the three new primitives. (spawn_subagent
// needs a live spawner and is covered by the subagent suites — omitted here.)

function fullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGrepTool());
  registry.register(createGlobTool());
  registry.register(createListDirTool());
  registry.register(createWriteFileTool());
  registry.register(createEditFileTool());
  registry.register(createBashTool());
  registry.register(createWebSearchTool({}));
  registry.register(createWebFetchTool());
  registry.register(createTodoTool({ todos: [] }));
  registry.register(createMemoryTool('/tmp/nova-test-memory/MEMORY.md'));
  return registry;
}

describe('search-tools inventory closeout', () => {
  it('registers the three new primitives alongside the non-subagent built-ins', () => {
    const names = fullRegistry()
      .getAll()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'bash',
      'edit_file',
      'glob',
      'grep',
      'list_dir',
      'memory_write',
      'read_file',
      'todo_write',
      'web_fetch',
      'web_search',
      'write_file',
    ]);
  });

  it('all three search tools are auto-permission and never cached', () => {
    const registry = fullRegistry();
    for (const name of ['grep', 'glob', 'list_dir']) {
      const tool = registry.get(name)!;
      expect(tool.permission?.mode, name).toBe('auto');
      expect(tool.metadata?.cacheable, name).toBe(false);
    }
  });

  it('tool definitions sort by name so the request prefix is registration-order independent', () => {
    const definitions = fullRegistry().toToolDefinitions();
    const names = definitions.map((d) => d.function.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('steers the model off bash for search in every new tool description', () => {
    const registry = fullRegistry();
    expect(registry.get('grep')!.description).toMatch(/prefer this over .{0,30}bash/i);
    expect(registry.get('glob')!.description).toMatch(/prefer this over .{0,30}bash/i);
    expect(registry.get('list_dir')!.description).toMatch(/prefer this over .{0,30}bash/i);
  });
});
