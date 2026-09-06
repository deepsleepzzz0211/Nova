import React from 'react';
import { Box, Text } from 'ink';
import type { TodoState } from '../tools/todo.js';

/** Props for the TodoView component. */
export interface TodoViewProps {
  /** Shared todo state maintained by the todo_write tool. */
  todoState: TodoState;
}

const MARKER_COLOR: Record<string, string> = {
  completed: 'green',
  in_progress: 'yellow',
  pending: 'gray',
};

const MARKER_TEXT: Record<string, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/**
 * Renders the agent's current todo list (presentational only).
 * Hidden when the list is empty.
 */
export function TodoView({ todoState }: TodoViewProps): React.ReactElement | null {
  if (todoState.todos.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={2} marginY={0}>
      <Text color="gray" dimColor>Tasks:</Text>
      {todoState.todos.map((todo, i) => (
        <Text key={i} color={MARKER_COLOR[todo.status] ?? 'gray'}>
          {`${MARKER_TEXT[todo.status] ?? '[ ]'} ${todo.content}`}
        </Text>
      ))}
    </Box>
  );
}
