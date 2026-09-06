import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createTodoTool, type TodoState } from '../../src/tools/todo.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import type { Tool } from '../../src/tools/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function ctx(dir = process.cwd()) {
  return { workingDirectory: dir, abortSignal: new AbortController().signal };
}

const ALL_TOOLS: Array<() => Tool> = [
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createBashTool,
  () => createTodoTool({ todos: [] }),
  createWebSearchTool,
  createWebFetchTool,
];

describe('Tool schemas (deterministic request prefix)', () => {
  it.each(ALL_TOOLS.map((f) => f().name))('%s has a complete schema', (name) => {
    const tool = ALL_TOOLS.find((f) => f().name === name)!();
    expect(tool.name).toBe(name);
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.parameters.type).toBe('object');
    expect(Object.keys(tool.parameters.properties as object).length).toBeGreaterThan(0);
    for (const prop of Object.values(tool.parameters.properties as Record<string, { type?: string; description?: string }>)) {
      expect(typeof prop.type).toBe('string');
      expect(prop.type!.length).toBeGreaterThan(0);
      expect(typeof prop.description).toBe('string');
      expect(prop.description!.length).toBeGreaterThan(0);
    }
    expect(Array.isArray(tool.parameters.required)).toBe(true);
  });

  it('todo_write declares enum statuses and required todos param', () => {
    const tool = createTodoTool({ todos: [] });
    const todos = (tool.parameters.properties as Record<string, { items?: { properties?: { status?: { enum?: string[] } } } }>).todos!;
    expect(todos.items?.properties?.status?.enum).toEqual(['pending', 'in_progress', 'completed']);
    expect(tool.parameters.required).toEqual(['todos']);
  });

  it('write_file declares both required params', () => {
    const tool = createWriteFileTool();
    expect(tool.parameters.required).toEqual(['path', 'content']);
  });
});

describe('Tool error-path contents', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-toolerr-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('read_file: directory error names the path and is an error', async () => {
    const sub = fs.mkdtempSync(path.join(tmp, 'dir-'));
    const result = await createReadFileTool().execute({ path: sub }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Path is a directory');
    expect(result.content).toContain(sub);
  });

  it('read_file: missing file error', async () => {
    const result = await createReadFileTool().execute({ path: path.join(tmp, 'nope.txt') }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('todo_write: non-string content rejected with specific message', async () => {
    const result = await createTodoTool({ todos: [] }).execute({ todos: [{ content: 42, status: 'pending' }] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty content string');
  });

  it('todo_write: invalid status rejected with the allowed values listed', async () => {
    const result = await createTodoTool({ todos: [] }).execute({ todos: [{ content: 'x', status: 'done' }] }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('pending, in_progress, completed');
  });

  it('write_file append mode appends instead of overwriting', async () => {
    const file = path.join(tmp, 'app.txt');
    const tool = createWriteFileTool();
    await tool.execute({ path: file, content: 'one' }, ctx(tmp));
    await tool.execute({ path: file, content: 'two', mode: 'append' }, ctx(tmp));
    expect(fs.readFileSync(file, 'utf-8')).toBe('onetwo');
  });

  it('bash: failing command reports nonzero exit code in metadata', async () => {
    const result = await createBashTool().execute(
      { command: `${process.execPath} -e "process.exit(7)"`, timeout: 10_000 },
      ctx(tmp),
    );
    expect(result.metadata?.exitCode).toBe(7);
  });

  it('bash: combines stdout and stderr', async () => {
    const result = await createBashTool().execute(
      {
        command: `${process.execPath} -e "console.log('out'); console.error('err')"`,
        timeout: 10_000,
      },
      ctx(tmp),
    );
    expect(result.content).toContain('out');
    expect(result.content).toContain('err');
    expect(result.metadata?.exitCode).toBe(0);
  });
});
