import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { DisplayMessage } from './display-types.js';
import { MarkdownText } from './MarkdownText.js';
import type { DisplayKindResolver } from './tool-summary.js';
import { groupToolCalls } from './tool-summary.js';
import { decoratedContextNotice } from './notice-line.js';
import { ToolCallView, ToolGroupRow } from './ToolCallView.js';
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
 * - User messages: full-width background band (tui-redesign 07)
 * - Assistant messages: white, rendered with MarkdownText
 * - Tool calls: embedded ToolCallView components
 */
function MessageBubbleImpl({ message, expandedToolIds, displayKind }: MessageBubbleProps): React.ReactElement {
  const { stdout } = useStdout();
  if (message.role === 'user') {
    // Full-width background band, no "> " prefix (tui-redesign 07).
    return (
      <Box flexDirection="column" marginY={0}>
        <Box width="100%" backgroundColor={theme.userBand} paddingX={1} paddingY={1}>
          <Text color={theme.userMessage}>{message.content}</Text>
        </Box>
      </Box>
    );
  }

  // System notices (compaction, etc.)
  if (message.role === 'system') {
    const rule = decoratedContextNotice(message.content, stdout.columns ?? 80);
    if (rule !== null) {
      return (
        <Box marginY={0}>
          <Text color={theme.systemNotice} dimColor>{rule}</Text>
        </Box>
      );
    }
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
          {groupToolCalls(
            message.toolCalls,
            (id) => expandedToolIds?.has(id) ?? false,
            displayKind,
          ).map((row) =>
            row.type === 'group' ? (
              <ToolGroupRow key={row.ids.join('+')} group={row} />
            ) : (
              <ToolCallView
                key={row.call.id}
                toolCall={row.call}
                expanded={expandedToolIds?.has(row.call.id) ?? false}
                displayKind={displayKind}
              />
            ),
          )}
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
