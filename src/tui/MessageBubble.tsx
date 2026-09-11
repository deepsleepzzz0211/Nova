import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayMessage } from './display-types.js';
import { MarkdownText } from './MarkdownText.js';
import type { DisplayKindResolver } from './tool-summary.js';
import { ToolCallView } from './ToolCallView.js';
import { theme } from './theme.js';

/** Props for the MessageBubble component. */
export interface MessageBubbleProps {
  /** The message to display. */
  message: DisplayMessage;
  /** Ids of tool blocks whose details are expanded (Ctrl+O, App-level). */
  expandedToolIds?: ReadonlySet<string>;
  /** Registry-backed tool display kind resolver. */
  displayKind?: DisplayKindResolver;
}

/**
 * Renders a single chat message.
 *
 * - User messages: blue, prefixed with "> "
 * - Assistant messages: white, rendered with MarkdownText
 * - Tool calls: embedded ToolCallView components
 */
function MessageBubbleImpl({ message, expandedToolIds, displayKind }: MessageBubbleProps): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginY={0}>
        <Box>
          <Text color={theme.userMessage} bold>{'> '}</Text>
          <Text color={theme.userMessage}>{message.content}</Text>
        </Box>
      </Box>
    );
  }

  // Reasoning stream (dim, italic, above the visible content)
  // System notices (compaction, etc.)
  if (message.role === 'system') {
    return (
      <Box marginY={0} paddingLeft={2}>
        <Text color={theme.systemNotice} dimColor italic>{message.content}</Text>
      </Box>
    );
  }

  // Assistant message
  return (
    <Box flexDirection="column" marginY={0}>
      {message.thinking && (
        <Box paddingLeft={0}>
          <Text color={theme.thinking} dimColor italic>{message.thinking}</Text>
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
            <ToolCallView
              key={tc.id}
              toolCall={tc}
              expanded={expandedToolIds?.has(tc.id) ?? false}
              displayKind={displayKind}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Memoised: submitted messages are immutable, so a parent re-render must
 * not re-render them (tui-refactor ticket 08). expandedToolIds/displayKind
 * change identity only on real interactions (App memoises displayKind).
 */
export const MessageBubble = React.memo(MessageBubbleImpl);
