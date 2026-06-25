import React from 'react';
import { Box, Text } from 'ink';

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Name of the active LLM model. */
  model: string;
  /** Current working directory. */
  workingDirectory: string;
  /** Number of active MCP server connections. */
  mcpConnectionCount: number;
}

/**
 * Displays a status bar showing the current model, working directory,
 * and number of active MCP connections.
 */
export function StatusBar({ model, workingDirectory, mcpConnectionCount }: StatusBarProps): React.ReactElement {
  const mcpLabel = mcpConnectionCount === 1
    ? '1 MCP server'
    : `${mcpConnectionCount} MCP servers`;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">{model}</Text>
      <Text color="gray" dimColor>{workingDirectory}</Text>
      <Text color="gray" dimColor>{mcpLabel}</Text>
    </Box>
  );
}
