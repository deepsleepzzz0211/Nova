import { describe, it, expect } from 'vitest';
import { createTodoTool, type TodoState } from '../../src/tools/todo.js';

function ctx() {
  return { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };
}

describe('todo_write tool', () => {
  it('stores todos and returns a formatted list with status markers', async () => {
    const state: TodoState = { todos: [] };
    const tool = createTodoTool(state);

    const result = await tool.execute(
      {
        todos: [
          { content: 'Research architectures', status: 'completed' },
          { content: 'Write plan', status: 'in_progress' },
          { content: 'Implement', status: 'pending' },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('[x] Research architectures');
    expect(result.content).toContain('[~] Write plan');
    expect(result.content).toContain('[ ] Implement');
    expect(state.todos).toHaveLength(3);
  });

  it('rejects invalid status values', async () => {
    const tool = createTodoTool({ todos: [] });
    const result = await tool.execute(
      { todos: [{ content: 'x', status: 'done' }] },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('status');
  });

  it('clears the list with an empty array', async () => {
    const state: TodoState = { todos: [{ content: 'old', status: 'pending' }] };
    const tool = createTodoTool(state);
    const result = await tool.execute({ todos: [] }, ctx());
    expect(result.content).toContain('cleared');
    expect(state.todos).toHaveLength(0);
  });

  it('rejects when todos param is missing or not an array', async () => {
    const tool = createTodoTool({ todos: [] });
    const r1 = await tool.execute({}, ctx());
    const r2 = await tool.execute({ todos: 'nope' }, ctx());
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
  });

  it('is permission-free and non-cacheable', () => {
    const tool = createTodoTool({ todos: [] });
    expect(tool.permission).toEqual({ mode: 'auto' });
    expect(tool.metadata?.cacheable).toBe(false);
  });
});
