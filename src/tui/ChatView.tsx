import React from 'react';
import { Box, Text } from 'ink';
import type { DisplayMessage } from './hooks/useAgent.js';
import { MessageBubble } from './MessageBubble.js';
import type { DisplayKindResolver } from './tool-summary.js';

/** Props for the ChatView component. */
export interface ChatViewProps {
  /** List of messages to display. */
  messages: DisplayMessage[];
  /** Ids of tool blocks whose details are expanded (Ctrl+O, App-level). */
  expandedToolIds?: ReadonlySet<string>;
  /** Registry-backed tool display kind resolver. */
  displayKind?: DisplayKindResolver;
}

/**
 * List of chat messages. Ink keeps the newest content visible; completed
 * messages join the static region in ticket 08 (no internal scrolling yet).
 */
export function ChatView({ messages, expandedToolIds, displayKind }: ChatViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} overflowY="hidden">
      {messages.map((msg, index) => (
        <MessageBubble
          key={index}
          message={msg}
          expandedToolIds={expandedToolIds}
          displayKind={displayKind}
        />
      ))}
      {messages.length === 0 && (
        <Box paddingY={1}>
          <Box paddingLeft={2}>
            <Text color="gray" dimColor>
              Welcome to Nova. Type a message to get started.
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
