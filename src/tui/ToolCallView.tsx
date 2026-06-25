import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DisplayToolCall } from './hooks/useAgent.js';

/** Props for the ToolCallView component. */
export interface ToolCallViewProps {
  /** The tool call to display. */
  toolCall: DisplayToolCall;
}

/**
 * Displays a tool call with name, parameters, result, and status.
 *
 * Parameters are collapsed by default; press Enter to toggle.
 * Status indicators:
 * - spinner (⠋) for running
 * - ✓ for done
 * - ✗ for error
 */
export function ToolCallView({ toolCall }: ToolCallViewProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  useInput((inputChar, key) => {
    if (key.return) {
      setExpanded((prev) => !prev);
    }
  });

  const statusIcon = toolCall.status === 'running'
    ? '⠋'
    : toolCall.status === 'done'
      ? '✓'
      : '✗';

  const statusColor = toolCall.status === 'running'
    ? 'yellow'
    : toolCall.status === 'done'
      ? 'green'
      : 'red';

  // Parse arguments for display
  let argsDisplay = '';
  try {
    const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    argsDisplay = JSON.stringify(parsed, null, 2);
  } catch {
    argsDisplay = toolCall.arguments;
  }

  // Truncate args for collapsed view
  const argsPreview = argsDisplay.length > 80
    ? argsDisplay.slice(0, 80) + '...'
    : argsDisplay;

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text bold color="yellow">{toolCall.name}</Text>
        {!expanded && argsPreview.length > 0 && (
          <Text color="gray" dimColor> {argsPreview}</Text>
        )}
      </Box>

      {expanded && (
        <Box flexDirection="column" paddingLeft={3}>
          <Text color="gray" dimColor>{argsDisplay}</Text>
        </Box>
      )}

      {toolCall.result !== undefined && expanded && (
        <Box flexDirection="column" paddingLeft={3} marginTop={0}>
          <Text color="gray">Result:</Text>
          <Text color={toolCall.status === 'error' ? 'red' : 'white'}>
            {truncateResult(toolCall.result)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Truncate long results for display. */
function truncateResult(result: string, maxLines = 20): string {
  const lines = result.split('\n');
  if (lines.length <= maxLines) return result;
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
}
