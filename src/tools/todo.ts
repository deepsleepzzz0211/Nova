import type { Tool, ToolContext, ToolResult } from './types.js';

const VALID_STATUSES = ['pending', 'in_progress', 'completed'] as const;
type TodoStatus = (typeof VALID_STATUSES)[number];

const STATUS_MARKER: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/** Shared, observable todo state (the TUI can render it too). */
export interface TodoState {
  todos: Array<{ content: string; status: TodoStatus }>;
}

function formatTodos(todos: TodoState['todos']): string {
  return todos.map((t) => `${STATUS_MARKER[t.status]} ${t.content}`).join('\n');
}

/**
 * todo_write — planning as a tool (mainstream pattern: the model maintains
 * its own task list instead of an external pipeline driving the loop).
 */
export function createTodoTool(state: TodoState): Tool {
  return {
    name: 'todo_write',
    description:
      'Maintain your task list for the current work. Provide the full list each time; use status pending/in_progress/completed to show progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list (replaces the previous list).',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description' },
              status: { type: 'string', enum: [...VALID_STATUSES] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    metadata: { category: 'planning', cacheable: false, timeout: 5000 },
    requiresPermission: () => false,
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const todos = params.todos;

      if (!Array.isArray(todos)) {
        return { content: 'Error: todos must be an array.', isError: true };
      }

      const parsed: TodoState['todos'] = [];
      for (const item of todos) {
        const entry = item as { content?: unknown; status?: unknown };
        if (typeof entry.content !== 'string' || !entry.content.trim()) {
          return { content: 'Error: each todo needs a non-empty content string.', isError: true };
        }
        if (typeof entry.status !== 'string' || !(VALID_STATUSES as readonly string[]).includes(entry.status)) {
          return {
            content: `Error: status must be one of ${VALID_STATUSES.join(', ')}.`,
            isError: true,
          };
        }
        parsed.push({ content: entry.content, status: entry.status as TodoStatus });
      }

      state.todos = parsed;

      if (parsed.length === 0) {
        return { content: 'Todo list cleared.' };
      }

      return { content: `Todo list updated (${parsed.length} items):\n${formatTodos(parsed)}` };
    },
  };
}
