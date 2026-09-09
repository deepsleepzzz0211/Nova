import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayMessage } from './hooks/useAgent.js';
import { MarkdownText } from './MarkdownText.js';
import { ToolCallView } from './ToolCallView.js';

/** Props for the MessageBubble component. */
export interface MessageBubbleProps {
  /** The message to display. */
  message: DisplayMessage;
}

/**
 * Renders a single chat message.
 *
 * - User messages: blue, prefixed with "> "
 * - Assistant messages: white, rendered with MarkdownText
 * - Tool calls: embedded ToolCallView components
 */
export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginY={0}>
        <Box>
          <Text color="blue" bold>{'> '}</Text>
          <Text color="blue">{message.content}</Text>
        </Box>
      </Box>
    );
  }

  // Reasoning stream (dim, italic, above the visible content)
  const thinking = 'thinking' in message ? message.thinking : undefined;

  // System notices (compaction, etc.)
  if (message.role === 'system') {
    return (
      <Box marginY={0} paddingLeft={2}>
        <Text color="gray" dimColor italic>{message.content}</Text>
      </Box>
    );
  }

  // Assistant message
  return (
    <Box flexDirection="column" marginY={0}>
      {thinking && (
        <Box paddingLeft={0} marginBottom={thinking.length > 0 ? 0 : undefined}>
          <Text color="gray" dimColor italic>{thinking}</Text>
        </Box>
      )}
      {message.content.length > 0 && (
        <Box paddingLeft={0}>
          <MarkdownText>{message.content}</MarkdownText>
        </Box>
      )}
      {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
        <Box flexDirection="column">
          {message.toolCalls.map((tc) => (
            <ToolCallView key={tc.id} toolCall={tc} />
          ))}
        </Box>
      )}
    </Box>
  );
}
